import { z } from 'zod'

/* ============================================================================
 * Rangos temporales y selección de resolución.
 *
 * Regla de la spec: un endpoint histórico devuelve entre 300 y 800 puntos por
 * serie, sin importar si el rango son 15 minutos o 7 días. Nadie manda un
 * millón de filas al navegador.
 * ========================================================================== */

export const RANGOS = {
  '15m': { etiqueta: '15 min', segundos: 15 * 60 },
  '1h': { etiqueta: '1 hora', segundos: 60 * 60 },
  '6h': { etiqueta: '6 horas', segundos: 6 * 60 * 60 },
  '24h': { etiqueta: '24 horas', segundos: 24 * 60 * 60 },
  '7d': { etiqueta: '7 días', segundos: 7 * 24 * 60 * 60 },
} as const

export type ClaveRango = keyof typeof RANGOS
export const CLAVES_RANGO = Object.keys(RANGOS) as [ClaveRango, ...ClaveRango[]]
export const esquemaRango = z.enum(CLAVES_RANGO)

/**
 * Las tres resoluciones que viven en la base, en segundos por muestra.
 *
 * `raw` es la cadencia del host (10 s); los contenedores se persisten cada
 * 30 s pero comparten la misma resolución lógica. `15m` y no `30m` para el
 * tramo largo: el gráfico de 7 días pide buckets de 900 s, y con agregados de
 * 30 minutos quedaría siempre «degradado» a la mitad de puntos.
 */
export const RESOLUCIONES = {
  raw: 10,
  '5m': 300,
  '15m': 900,
} as const

export type Resolucion = keyof typeof RESOLUCIONES
export const CLAVES_RESOLUCION = Object.keys(RESOLUCIONES) as [Resolucion, ...Resolucion[]]
export const esquemaResolucion = z.enum(CLAVES_RESOLUCION)

/**
 * Retención de cada resolución, en horas. Fija: es lo que mantiene acotado el
 * disco de la VM, y no una preferencia que convenga estirar desde la UI.
 *
 *   - crudos  26 h  → resolución completa para el rango de 24 h, con margen.
 *   - 5 min   3 días
 *   - 15 min  7 días → lo más viejo que se guarda. Nada pasa de una semana.
 *
 * Las resoluciones se solapan (el agregado de 15 min también cubre las últimas
 * horas) porque cada consulta lee de una sola fuente. El volumen lo ponen los
 * crudos, así que el solapamiento cuesta poco.
 */
export const RETENCION_HORAS: Record<Resolucion, number> = {
  raw: 26,
  '5m': 72,
  '15m': 168,
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
  retencionHoras: Record<Resolucion, number> = RETENCION_HORAS,
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
  const antiguedadHoras = (Date.now() - desde.getTime()) / 3_600_000

  const disponibles = CLAVES_RESOLUCION.filter(
    (r) => antiguedadHoras <= (retencionHoras[r] ?? 0),
  )
  // Preferimos la fuente más fina que quepa en el bucket: agregar hacia abajo
  // siempre es correcto, interpolar hacia arriba no.
  const masFina = disponibles.find((r) => RESOLUCIONES[r] <= bucket)
  // Si ninguna disponible entra en el bucket, la más fina de las que quedan:
  // es la que menos degrada.
  // Si ninguna cubre el rango entero (7 días justos ya rozan el borde de la
  // retención más larga), la que más atrás llega: es la que menos hueco deja.
  const masLarga = CLAVES_RESOLUCION.toSorted(
    (a, b) => (retencionHoras[b] ?? 0) - (retencionHoras[a] ?? 0),
  )[0]
  const fuente = masFina ?? disponibles[0] ?? masLarga ?? '15m'
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
