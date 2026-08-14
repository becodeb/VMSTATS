import { desc, sql } from 'drizzle-orm'
import {
  SERIES_HISTORIAL,
  planificarConsulta,
  type ClaveSerie,
  type Punto,
  type RespuestaHistorial,
  type Serie,
} from '@vmstats/shared'
import { hosts, type BaseDatos, type PreferenciasApp } from '@vmstats/db'
import { aFecha, aNumeroOpcional } from './filas.js'

/* ============================================================================
 * Consultas de historial.
 *
 * Dos cosas pasan acá y las dos importan:
 *
 * 1. La resolución se elige sola. El navegador pide un rango, no una
 *    granularidad; el planificador de @vmstats/shared decide de qué resolución
 *    leer y con qué ancho de bucket para devolver entre 300 y 800 puntos. Pedir
 *    30 días nunca manda 260.000 filas.
 *
 * 2. Los huecos se conservan. La grilla de buckets sale de `generate_series` y
 *    los datos entran por LEFT JOIN, así que un período sin muestras produce
 *    `null` y el gráfico dibuja una interrupción. Un `GROUP BY` a secas
 *    saltearía esos buckets y el gráfico uniría los extremos con una recta que
 *    daría a entender que el sistema estuvo funcionando.
 * ========================================================================== */

/**
 * Expresión SQL de cada serie.
 *
 * El mapa es fijo y las claves vienen validadas por el enum de Zod, así que
 * nada de lo que manda el cliente llega a interpolarse en el SQL.
 */
const EXPRESIONES: Record<ClaveSerie, string> = {
  'cpu.total': 'avg(cpu_total)',
  'cpu.user': 'avg(cpu_user)',
  'cpu.system': 'avg(cpu_system)',
  'cpu.iowait': 'avg(cpu_iowait)',
  'cpu.steal': 'avg(cpu_steal)',
  'carga.uno': 'avg(load_1)',
  'carga.cinco': 'avg(load_5)',
  'carga.quince': 'avg(load_15)',
  'memoria.usada': 'avg(mem_used)',
  'memoria.disponible': 'avg(mem_available)',
  'memoria.cache': 'avg(mem_cached)',
  'memoria.swapUsada': 'avg(swap_used)',
  'red.rx': 'avg(net_rx_bps)',
  'red.tx': 'avg(net_tx_bps)',
  'disco.lectura': 'avg(disk_read_bps)',
  'disco.escritura': 'avg(disk_write_bps)',
  'presion.cpu': 'avg(psi_cpu_some10)',
  'presion.memoria': 'avg(psi_mem_some10)',
  'presion.io': 'avg(psi_io_some10)',
  'tcp.establecidas': 'avg(tcp_established)',
}

/** Misma grilla fija que usa el rollup, para que los buckets coincidan. */
const ORIGEN_GRILLA = '2000-01-01T00:00:00Z'

/**
 * El host a consultar.
 *
 * vmstats está pensado para una VM, pero el esquema soporta varias. Sin
 * `hostId` explícito se toma el que reportó más recientemente.
 */
export async function hostPorDefecto(db: BaseDatos): Promise<string | null> {
  const filas = await db
    .select({ id: hosts.id })
    .from(hosts)
    .orderBy(desc(hosts.vistoUltimoEn))
    .limit(1)
  return filas[0]?.id ?? null
}

export interface OpcionesHistorial {
  desde: Date
  hasta: Date
  series: readonly ClaveSerie[]
  hostId?: string | undefined
  preferencias: PreferenciasApp
}

export async function consultarHistorial(
  db: BaseDatos,
  opciones: OpcionesHistorial,
): Promise<RespuestaHistorial> {
  const hostId = opciones.hostId ?? (await hostPorDefecto(db))

  const plan = planificarConsulta(opciones.desde, opciones.hasta, {
    raw: opciones.preferencias.retencionRawDias,
    '1m': opciones.preferencias.retencionUnMinutoDias,
    '5m': opciones.preferencias.retencionCincoMinutosDias,
  })

  const vacio: RespuestaHistorial = {
    desde: opciones.desde.toISOString(),
    hasta: opciones.hasta.toISOString(),
    resolucion: plan.fuente,
    bucketSegundos: plan.bucketSegundos,
    degradado: plan.degradado,
    series: opciones.series.map((clave) => ({
      clave,
      etiqueta: SERIES_HISTORIAL[clave].etiqueta,
      unidad: SERIES_HISTORIAL[clave].unidad,
      puntos: [],
    })),
  }

  if (hostId === null) return vacio

  // Las columnas se numeran para no depender de cómo Postgres normaliza los
  // alias de expresiones agregadas.
  const selecciones = opciones.series
    .map((clave, i) => `${EXPRESIONES[clave]} AS s${i}`)
    .join(', ')
  const proyecciones = opciones.series.map((_, i) => `d.s${i}`).join(', ')

  const intervalo = sql.raw(`interval '${plan.bucketSegundos} seconds'`)
  const origen = sql.raw(`timestamptz '${ORIGEN_GRILLA}'`)

  const resultado = await db.execute<Record<string, unknown>>(sql`
    WITH grilla AS (
      SELECT generate_series(
        date_bin(${intervalo}, ${opciones.desde}::timestamptz, ${origen}),
        ${opciones.hasta}::timestamptz,
        ${intervalo}
      ) AS bucket
    ),
    datos AS (
      SELECT date_bin(${intervalo}, ts, ${origen}) AS bucket,
             ${sql.raw(selecciones)}
      FROM host_metric_samples
      WHERE host_id = ${hostId}
        AND resolution = ${plan.fuente}
        AND ts >= ${opciones.desde}::timestamptz
        AND ts <= ${opciones.hasta}::timestamptz
      GROUP BY 1
    )
    SELECT g.bucket, ${sql.raw(proyecciones)}
    FROM grilla g
    LEFT JOIN datos d ON d.bucket = g.bucket
    ORDER BY g.bucket
  `)

  const series: Serie[] = opciones.series.map((clave, i) => {
    const puntos: Punto[] = resultado.rows.map((fila) => {
      // `avg()` devuelve numeric, que el driver entrega como string, y las
      // fechas pueden llegar como Date o como texto. `null` acá es un hueco
      // real en los datos y se preserva tal cual.
      const ms = aFecha(fila['bucket']).getTime()
      return [ms, aNumeroOpcional(fila[`s${i}`])]
    })

    return {
      clave,
      etiqueta: SERIES_HISTORIAL[clave].etiqueta,
      unidad: SERIES_HISTORIAL[clave].unidad,
      puntos,
    }
  })

  return { ...vacio, series }
}

/* -------------------------------------------------------------------------
 * Exportación CSV
 * ---------------------------------------------------------------------- */

/**
 * Escapa un campo de CSV.
 *
 * Además de las comillas, se neutraliza la inyección de fórmulas: un valor que
 * empieza con `=`, `+`, `-` o `@` lo ejecuta Excel al abrir el archivo. Se le
 * antepone una comilla simple, que es la convención para forzar texto.
 */
function campoCsv(valor: string | number | null): string {
  if (valor === null) return ''
  const texto = String(valor)
  const peligroso = /^[=+\-@\t\r]/.test(texto)
  const preparado = peligroso ? `'${texto}` : texto
  if (/[",\n\r]/.test(preparado)) return `"${preparado.replace(/"/g, '""')}"`
  return preparado
}

/** Convierte la respuesta a CSV con una columna por serie. */
export function historialACsv(respuesta: RespuestaHistorial): string {
  const cabecera = [
    'ts_utc',
    ...respuesta.series.map((s) => `${s.clave}${s.unidad === '' ? '' : ` (${s.unidad})`}`),
  ]

  const filas: string[][] = []
  const primera = respuesta.series[0]
  const cantidad = primera?.puntos.length ?? 0

  for (let i = 0; i < cantidad; i += 1) {
    const marca = primera?.puntos[i]?.[0]
    if (marca === undefined) continue
    filas.push([
      new Date(marca).toISOString(),
      ...respuesta.series.map((s) => {
        const valor = s.puntos[i]?.[1] ?? null
        return valor === null ? '' : valor.toFixed(4)
      }),
    ])
  }

  return [cabecera, ...filas].map((fila) => fila.map(campoCsv).join(',')).join('\r\n')
}
