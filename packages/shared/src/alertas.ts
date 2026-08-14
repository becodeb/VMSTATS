import { z } from 'zod'

/* ============================================================================
 * Reglas de alerta y su evaluación.
 *
 * La evaluación vive acá, pura, en vez de en el collector: así se puede testear
 * la histéresis y el cooldown con relojes falsos sin levantar una base.
 * ========================================================================== */

/** Métricas sobre las que se puede alertar, con su unidad para la UI. */
export const METRICAS_ALERTA = {
  'cpu.total': { etiqueta: 'CPU total', unidad: '%' },
  'cpu.iowait': { etiqueta: 'CPU en iowait', unidad: '%' },
  'cpu.steal': { etiqueta: 'CPU robada', unidad: '%' },
  'memoria.usadaPorcentaje': { etiqueta: 'Memoria usada', unidad: '%' },
  'memoria.swapPorcentaje': { etiqueta: 'Swap usada', unidad: '%' },
  'carga.porNucleo': { etiqueta: 'Load average por núcleo', unidad: '' },
  'disco.usadoPorcentaje': { etiqueta: 'Filesystem más lleno', unidad: '%' },
  'red.rxBytesPorSeg': { etiqueta: 'Red entrante', unidad: 'B/s' },
  'red.txBytesPorSeg': { etiqueta: 'Red saliente', unidad: 'B/s' },
  'presion.cpu': { etiqueta: 'Presión de CPU', unidad: '%' },
  'presion.memoria': { etiqueta: 'Presión de memoria', unidad: '%' },
  'presion.io': { etiqueta: 'Presión de I/O', unidad: '%' },
  'contenedor.caido': { etiqueta: 'Contenedores no saludables', unidad: '' },
  'collector.silencioSegundos': { etiqueta: 'Silencio del collector', unidad: 's' },
} as const

export type MetricaAlerta = keyof typeof METRICAS_ALERTA
export const CLAVES_METRICA_ALERTA = Object.keys(METRICAS_ALERTA) as [
  MetricaAlerta,
  ...MetricaAlerta[],
]
export const esquemaMetricaAlerta = z.enum(CLAVES_METRICA_ALERTA)

export const esquemaSeveridad = z.enum(['warning', 'critical'])
export type Severidad = z.infer<typeof esquemaSeveridad>

export const esquemaOperador = z.enum(['mayor', 'menor'])
export type Operador = z.infer<typeof esquemaOperador>

export const esquemaReglaAlerta = z.object({
  id: z.number().int(),
  nombre: z.string().min(1).max(120),
  metrica: esquemaMetricaAlerta,
  operador: esquemaOperador,
  umbral: z.number(),
  severidad: esquemaSeveridad,
  /** Cuánto tiene que sostenerse la condición antes de disparar. Evita que un
   *  pico de 5 segundos genere una alerta. */
  duracionMinimaSegundos: z.number().int().min(0).max(86_400),
  /** Tras resolverse, cuánto esperar antes de volver a poder disparar. */
  cooldownSegundos: z.number().int().min(0).max(86_400),
  /** Margen que hay que cruzar de vuelta para resolver. Sin esto, un valor
   *  oscilando alrededor del umbral genera alertas en ráfaga. */
  histeresis: z.number().min(0),
  habilitada: z.boolean(),
  silenciadaHasta: z.iso.datetime().nullable(),
})
export type ReglaAlerta = z.infer<typeof esquemaReglaAlerta>

export const esquemaEntradaReglaAlerta = esquemaReglaAlerta.omit({ id: true })
export type EntradaReglaAlerta = z.infer<typeof esquemaEntradaReglaAlerta>

export const esquemaEstadoInstancia = z.enum(['activa', 'reconocida', 'resuelta'])
export type EstadoInstancia = z.infer<typeof esquemaEstadoInstancia>

export const esquemaInstanciaAlerta = z.object({
  id: z.number().int(),
  reglaId: z.number().int(),
  reglaNombre: z.string(),
  metrica: esquemaMetricaAlerta,
  severidad: esquemaSeveridad,
  estado: esquemaEstadoInstancia,
  valorDisparo: z.number(),
  umbral: z.number(),
  iniciadaEn: z.iso.datetime(),
  resueltaEn: z.iso.datetime().nullable(),
  reconocidaEn: z.iso.datetime().nullable(),
  reconocidaPor: z.string().nullable(),
})
export type InstanciaAlerta = z.infer<typeof esquemaInstanciaAlerta>

/* -------------------------------------------------------------------------
 * Máquina de estados
 * ---------------------------------------------------------------------- */

/** Lo que la evaluación necesita recordar entre muestras, por regla. */
export interface EstadoEvaluacion {
  /** Desde cuándo se cumple la condición sin interrupción (ms epoch). */
  condicionDesde: number | null
  /** Si hay una alerta abierta ahora mismo. */
  activaDesde: number | null
  /** Cuándo se resolvió la última, para respetar el cooldown (ms epoch). */
  ultimaResolucion: number | null
}

export const ESTADO_EVALUACION_INICIAL: EstadoEvaluacion = {
  condicionDesde: null,
  activaDesde: null,
  ultimaResolucion: null,
}

export type AccionAlerta =
  | { tipo: 'abrir'; valor: number }
  | { tipo: 'resolver' }
  | { tipo: 'ninguna' }

export interface ResultadoEvaluacion {
  estado: EstadoEvaluacion
  accion: AccionAlerta
}

/** ¿El valor cruza el umbral en la dirección de la regla? */
export function condicionSeCumple(regla: ReglaAlerta, valor: number): boolean {
  return regla.operador === 'mayor' ? valor > regla.umbral : valor < regla.umbral
}

/**
 * Umbral de salida, corrido por la histéresis.
 *
 * Para una regla `mayor`, la alerta abre en `umbral` pero recién cierra en
 * `umbral - histeresis`: un valor que oscila alrededor del umbral se queda
 * en una sola alerta en vez de generar una por muestra.
 */
export function umbralDeSalida(regla: ReglaAlerta): number {
  return regla.operador === 'mayor'
    ? regla.umbral - regla.histeresis
    : regla.umbral + regla.histeresis
}

function condicionDeSalidaSeCumple(regla: ReglaAlerta, valor: number): boolean {
  const salida = umbralDeSalida(regla)
  return regla.operador === 'mayor' ? valor <= salida : valor >= salida
}

/**
 * Avanza la máquina de estados de una regla con una muestra nueva.
 *
 * Pura a propósito: `ahora` entra por parámetro para poder testear duración
 * mínima, cooldown e histéresis sin esperar en tiempo real.
 */
export function evaluarRegla(
  regla: ReglaAlerta,
  valor: number,
  ahora: number,
  previo: EstadoEvaluacion,
): ResultadoEvaluacion {
  if (!regla.habilitada) {
    // Comparación explícita contra null: `activaDesde` es una marca de tiempo, y
    // con un truthy check el instante 0 se lee como «no hay alerta abierta».
    return {
      estado: ESTADO_EVALUACION_INICIAL,
      accion: previo.activaDesde !== null ? { tipo: 'resolver' } : { tipo: 'ninguna' },
    }
  }

  const silenciada =
    regla.silenciadaHasta !== null && Date.parse(regla.silenciadaHasta) > ahora

  // Con una alerta abierta, la pregunta es si ya podemos cerrarla.
  if (previo.activaDesde !== null) {
    if (condicionDeSalidaSeCumple(regla, valor)) {
      return {
        estado: { condicionDesde: null, activaDesde: null, ultimaResolucion: ahora },
        accion: { tipo: 'resolver' },
      }
    }
    return { estado: previo, accion: { tipo: 'ninguna' } }
  }

  if (!condicionSeCumple(regla, valor)) {
    return {
      estado: { ...previo, condicionDesde: null },
      accion: { tipo: 'ninguna' },
    }
  }

  const desde = previo.condicionDesde ?? ahora
  const sostenidaMs = ahora - desde
  const suficiente = sostenidaMs >= regla.duracionMinimaSegundos * 1000

  const enCooldown =
    previo.ultimaResolucion !== null &&
    ahora - previo.ultimaResolucion < regla.cooldownSegundos * 1000

  if (!suficiente || enCooldown || silenciada) {
    // El reloj de la condición sigue corriendo incluso silenciada: cuando se
    // levante el silencio la alerta dispara sin volver a esperar la duración.
    return { estado: { ...previo, condicionDesde: desde }, accion: { tipo: 'ninguna' } }
  }

  return {
    estado: { condicionDesde: desde, activaDesde: ahora, ultimaResolucion: previo.ultimaResolucion },
    accion: { tipo: 'abrir', valor },
  }
}
