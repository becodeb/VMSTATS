import { setTimeout as esperar } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { CLAVES_RESOLUCION, RETENCION_HORAS, type Resolucion } from '@vmstats/shared'
import type { BaseDatos } from '@vmstats/db'

/* ============================================================================
 * Retención.
 *
 * Esquema fijo, progresivo (ver RETENCION_HORAS en @vmstats/shared):
 *
 *   crudos 26 h  →  5 min 3 días  →  15 min 7 días  →  se borra
 *
 * Además se borra cualquier resolución que ya no exista en el esquema (los
 * agregados de 1 minuto de la versión anterior), sin importar su antigüedad.
 *
 * Borra en tandas acotadas en vez de un `DELETE` gigante. Un borrado de varios
 * millones de filas toma locks largos y hace crecer el WAL de golpe; en una VM
 * chica eso se nota como una pausa en todo lo demás, justo el tipo de problema
 * que este sistema tendría que estar detectando y no causando. Entre tanda y
 * tanda hay una pausa corta para que la ingesta y el autovacuum respiren.
 * ========================================================================== */

const TAMANIO_TANDA = 10_000
/** Techo de tandas por tabla y corrida: si hay mucho atraso, se sigue en la
 *  próxima (el collector la adelanta cuando `quedaTrabajo`). */
const MAX_TANDAS = 60
const PAUSA_ENTRE_TANDAS_MS = 150

export const TABLAS_METRICAS = [
  'host_metric_samples',
  'network_metric_samples',
  'disk_metric_samples',
  'filesystem_metric_samples',
  'container_metric_samples',
] as const

export interface ResultadoRetencion {
  borradas: number
  quedaTrabajo: boolean
}

/**
 * Condiciones de «vencida» para una tabla: una por resolución —cada una se
 * resuelve con el índice (resolution, ts)— y una más para las resoluciones que
 * ya no existen en el esquema.
 */
function condicionesVencidas(retencion: Record<Resolucion, number>) {
  const conocidas = sql.join(
    CLAVES_RESOLUCION.map((r) => sql`${r}`),
    sql`, `,
  )
  return [
    ...CLAVES_RESOLUCION.map(
      (r) =>
        sql`resolution = ${r} AND ts < now() - make_interval(hours => ${retencion[r]}::int)`,
    ),
    sql`resolution NOT IN (${conocidas})`,
  ]
}

/**
 * Borra una tanda tras otra hasta que no quede nada vencido o se llegue al
 * techo de la corrida.
 *
 * Se selecciona por `ctid` (la dirección física de la fila) y se borra con
 * `ctid = ANY(ARRAY(...))`: así Postgres resuelve el borrado con un Tid Scan.
 * La variante `ctid IN (SELECT ...)` puede terminar en un semi-join que agrega
 * y ordena cada tanda antes de borrar.
 */
async function purgarTabla(
  db: BaseDatos,
  tabla: string,
  retencion: Record<Resolucion, number>,
): Promise<ResultadoRetencion> {
  let borradas = 0
  let tandas = 0

  for (const vencida of condicionesVencidas(retencion)) {
    for (;;) {
      if (tandas >= MAX_TANDAS) return { borradas, quedaTrabajo: true }
      tandas += 1

      const resultado = await db.execute(sql`
        DELETE FROM ${sql.raw(tabla)}
        WHERE ctid = ANY(ARRAY(
          SELECT ctid FROM ${sql.raw(tabla)}
          WHERE ${vencida}
          LIMIT ${TAMANIO_TANDA}
        ))
      `)

      const filas = resultado.rowCount ?? 0
      borradas += filas
      if (filas < TAMANIO_TANDA) break
      await esperar(PAUSA_ENTRE_TANDAS_MS)
    }
  }

  return { borradas, quedaTrabajo: false }
}

export interface ResumenRetencion {
  metricas: number
  intentosLogin: number
  sesiones: number
  quedaTrabajo: boolean
}

export async function correrRetencion(
  db: BaseDatos,
  retencion: Record<Resolucion, number> = RETENCION_HORAS,
): Promise<ResumenRetencion> {
  let metricas = 0
  let quedaTrabajo = false

  for (const tabla of TABLAS_METRICAS) {
    const resultado = await purgarTabla(db, tabla, retencion)
    metricas += resultado.borradas
    if (resultado.quedaTrabajo) quedaTrabajo = true
  }

  // Los intentos de login sólo sirven para el rate limiting de la última hora;
  // guardarlos más tiempo es acumular direcciones IP sin motivo.
  const login = await db.execute(
    sql`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`,
  )

  // Sesiones vencidas: la validación ya las rechaza por fecha, esto es sólo
  // higiene de la tabla.
  const sesiones = await db.execute(
    sql`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`,
  )

  return {
    metricas,
    intentosLogin: login.rowCount ?? 0,
    sesiones: sesiones.rowCount ?? 0,
    quedaTrabajo,
  }
}
