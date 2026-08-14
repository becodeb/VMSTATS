import { z } from 'zod'

/* ============================================================================
 * Rangos temporales y selección de resolución.
 *
 * Regla de la spec: un endpoint histórico devuelve entre 300 y 800 puntos por
 * serie, sin importar si el rango son 15 minutos o 30 días. Nadie manda un
 * millón de filas al navegador.
 * ========================================================================== */

export const RANGOS = {
  '15m': { etiqueta: '15 min', segundos: 15 * 60 },
  '1h': { etiqueta: '1 hora', segundos: 60 * 60 },
  '6h': { etiqueta: '6 horas', segundos: 6 * 60 * 60 },
  '24h': { etiqueta: '24 horas', segundos: 24 * 60 * 60 },
  '7d': { etiqueta: '7 días', segundos: 7 * 24 * 60 * 60 },
  '30d': { etiqueta: '30 días', segundos: 30 * 24 * 60 * 60 },
} as const

export type ClaveRango = keyof typeof RANGOS
export const CLAVES_RANGO = Object.keys(RANGOS) as [ClaveRango, ...ClaveRango[]]
export const esquemaRango = z.enum(CLAVES_RANGO)

/** Las tres resoluciones que viven en la base, en segundos por muestra. */
export const RESOLUCIONES = {
  raw: 10,
  '1m': 60,
  '5m': 300,
} as const

export type Resolucion = keyof typeof RESOLUCIONES
export const CLAVES_RESOLUCION = Object.keys(RESOLUCIONES) as [Resolucion, ...Resolucion[]]
export const esquemaResolucion = z.enum(CLAVES_RESOLUCION)

/** Retención por defecto, en días. Configurable vía app_settings. */
export const RETENCION_POR_DEFECTO: Record<Resolucion, number> = {
  raw: 7,
  '1m': 30,
  '5m': 365,
}

/**
 * Anchos de bucket permitidos, en segundos.
 *
 * Es una escalera de valores "redondos" a propósito: un bucket de 47 segundos
 * daría una grilla temporal que no se alinea con nada y hace ilegibles los
 * ejes. Cada escalón es como mucho el doble del anterior, así que el conteo de
 * puntos nunca cae por debajo de la mitad del techo.
 */
const ESCALERA_BUCKETS = [
  10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400,
] as const

export const PUNTOS_MINIMOS = 300
export const PUNTOS_MAXIMOS = 800

export interface PlanConsulta {
  /** De qué tabla-resolución leer. */
  fuente: Resolucion
  /** Ancho del bucket de agregación, en segundos. */
  bucketSegundos: number
  puntosEstimados: number
  /** true si el rango pedido excede la retención de la fuente más fina y hubo
   *  que degradar. La UI lo dice en vez de mentir sobre la granularidad. */
  degradado: boolean
}

/**
 * Elige fuente y ancho de bucket para un rango.
 *
 * Dos restricciones a la vez: el bucket tiene que dar 300-800 puntos, y la
 * resolución de origen tiene que existir todavía para ese rango — pedir 30 días
 * de datos crudos no sirve si los crudos se borran a los 7.
 */
export function planificarConsulta(
  desde: Date,
  hasta: Date,
  retencionDias: Record<Resolucion, number> = RETENCION_POR_DEFECTO,
  objetivoMaximo: number = PUNTOS_MAXIMOS,
): PlanConsulta {
  const duracionSeg = Math.max(1, Math.round((hasta.getTime() - desde.getTime()) / 1000))

  // El bucket más chico de la escalera que no se pase del techo de puntos.
  let bucket = ESCALERA_BUCKETS[ESCALERA_BUCKETS.length - 1] ?? 86_400
  for (const candidato of ESCALERA_BUCKETS) {
    if (duracionSeg / candidato <= objetivoMaximo) {
      bucket = candidato
      break
    }
  }

  // Antigüedad del extremo más viejo del rango: decide qué resoluciones
  // todavía tienen datos ahí.
  const antiguedadDias = (Date.now() - desde.getTime()) / 86_400_000

  const disponibles = CLAVES_RESOLUCION.filter(
    (r) => antiguedadDias <= (retencionDias[r] ?? 0),
  )
  // Preferimos la fuente más fina que quepa en el bucket: agregar hacia abajo
  // siempre es correcto, interpolar hacia arriba no.
  const masFina = disponibles.find((r) => RESOLUCIONES[r] <= bucket)
  const fuente = masFina ?? disponibles[disponibles.length - 1] ?? '5m'
  const degradado = RESOLUCIONES[fuente] > bucket

  // Si tuvimos que degradar, el bucket no puede ser más fino que la fuente.
  const bucketFinal = Math.max(bucket, RESOLUCIONES[fuente])

  return {
    fuente,
    bucketSegundos: bucketFinal,
    puntosEstimados: Math.ceil(duracionSeg / bucketFinal),
    degradado,
  }
}

/** El rango equivalente inmediatamente anterior, para comparaciones. */
export function periodoAnterior(desde: Date, hasta: Date): { desde: Date; hasta: Date } {
  const duracion = hasta.getTime() - desde.getTime()
  return { desde: new Date(desde.getTime() - duracion), hasta: new Date(desde.getTime()) }
}

export function rangoDesdeClave(clave: ClaveRango, ahora: Date = new Date()): {
  desde: Date
  hasta: Date
} {
  const rango = RANGOS[clave]
  return { desde: new Date(ahora.getTime() - rango.segundos * 1000), hasta: ahora }
}

/** Zona horaria de visualización por defecto. Los datos siempre son UTC. */
export const ZONA_HORARIA_POR_DEFECTO = 'America/Miquelon'
