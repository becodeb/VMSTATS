import { sql } from 'drizzle-orm'
import type { BaseDatos, PreferenciasApp } from '@vmstats/db'

/* ============================================================================
 * Retención.
 *
 * Borra en tandas acotadas en vez de un `DELETE` gigante. Un borrado de varios
 * millones de filas toma locks largos y hace crecer el WAL de golpe; en una VM
 * chica eso se nota como una pausa en todo lo demás, justo el tipo de problema
 * que este sistema tendría que estar detectando y no causando.
 * ========================================================================== */

const TAMANIO_TANDA = 20_000
/** Techo de tandas por corrida: si hay mucho atraso, se sigue en la próxima. */
const MAX_TANDAS = 50

const TABLAS = [
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
 * Borra las filas de una resolución más viejas que su ventana.
 *
 * El `ctid` es la dirección física de la fila: seleccionar por ctid y borrar
 * por ctid es la forma barata de acotar una tanda sin tener que ordenar por un
 * índice.
 */
async function purgarTabla(
  db: BaseDatos,
  tabla: string,
  resolucion: string,
  dias: number,
): Promise<ResultadoRetencion> {
  let borradas = 0

  for (let tanda = 0; tanda < MAX_TANDAS; tanda += 1) {
    const resultado = await db.execute(
      sql`
        DELETE FROM ${sql.raw(tabla)}
        WHERE ctid IN (
          SELECT ctid FROM ${sql.raw(tabla)}
          WHERE resolution = ${resolucion}
            AND ts < now() - ${sql.raw(`interval '${dias} days'`)}
          LIMIT ${TAMANIO_TANDA}
        )
      `,
    )

    const filas = resultado.rowCount ?? 0
    borradas += filas
    if (filas < TAMANIO_TANDA) return { borradas, quedaTrabajo: false }
  }

  return { borradas, quedaTrabajo: true }
}

export interface ResumenRetencion {
  metricas: number
  intentosLogin: number
  sesiones: number
  quedaTrabajo: boolean
}

export async function correrRetencion(
  db: BaseDatos,
  preferencias: PreferenciasApp,
): Promise<ResumenRetencion> {
  const ventanas: readonly [string, number][] = [
    ['raw', preferencias.retencionRawDias],
    ['1m', preferencias.retencionUnMinutoDias],
    ['5m', preferencias.retencionCincoMinutosDias],
  ]

  let metricas = 0
  let quedaTrabajo = false

  for (const tabla of TABLAS) {
    for (const [resolucion, dias] of ventanas) {
      const resultado = await purgarTabla(db, tabla, resolucion, dias)
      metricas += resultado.borradas
      if (resultado.quedaTrabajo) quedaTrabajo = true
    }
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
