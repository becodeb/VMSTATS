import { z } from 'zod'

/* ============================================================================
 * Estado general y umbrales.
 *
 * `sin-datos` es un estado de primera clase, no un caso borde: si el collector
 * dejó de reportar, la respuesta honesta no es «saludable» — es «no sé».
 * ========================================================================== */

export const ESTADOS = ['saludable', 'advertencia', 'critico', 'sin-datos'] as const
export const esquemaEstadoGeneral = z.enum(ESTADOS)
/** No confundir con el `EstadoSalud` de contenedores: aquél es el HEALTHCHECK
 *  de Docker, éste es el semáforo del sistema entero. */
export type EstadoGeneral = z.infer<typeof esquemaEstadoGeneral>

const SEVERIDAD_ORDEN: Record<EstadoGeneral, number> = {
  saludable: 0,
  'sin-datos': 1,
  advertencia: 2,
  critico: 3,
}

/** El peor de un conjunto. Un host es tan sano como su peor señal. */
export function peorEstado(estados: readonly EstadoGeneral[]): EstadoGeneral {
  let peor: EstadoGeneral = 'saludable'
  for (const e of estados) {
    if (SEVERIDAD_ORDEN[e] > SEVERIDAD_ORDEN[peor]) peor = e
  }
  return peor
}

export interface Umbral {
  advertencia: number
  critico: number
}

/** Umbrales por defecto de los medidores del Resumen. */
export const UMBRALES = {
  cpu: { advertencia: 80, critico: 92 },
  memoria: { advertencia: 85, critico: 94 },
  swap: { advertencia: 25, critico: 60 },
  disco: { advertencia: 80, critico: 90 },
  cargaPorNucleo: { advertencia: 1.5, critico: 2.5 },
  presion: { advertencia: 20, critico: 50 },
  steal: { advertencia: 5, critico: 15 },
} as const satisfies Record<string, Umbral>

export function clasificar(valor: number | null, umbral: Umbral): EstadoGeneral {
  if (valor === null || Number.isNaN(valor)) return 'sin-datos'
  if (valor >= umbral.critico) return 'critico'
  if (valor >= umbral.advertencia) return 'advertencia'
  return 'saludable'
}

/**
 * Cuántos segundos de silencio del collector toleramos antes de marcar los
 * datos como desactualizados.
 *
 * El collector persiste cada 10s; tres ciclos perdidos ya es un problema real
 * y no un hipo de red.
 */
export const SEGUNDOS_PARA_DESACTUALIZADO = 35

export function datosDesactualizados(
  ultimaMuestra: Date | null,
  ahora: Date = new Date(),
  toleranciaSegundos: number = SEGUNDOS_PARA_DESACTUALIZADO,
): boolean {
  if (ultimaMuestra === null) return true
  return ahora.getTime() - ultimaMuestra.getTime() > toleranciaSegundos * 1000
}

/** Etiqueta accesible: el estado nunca se comunica sólo por color. */
export const ETIQUETA_ESTADO: Record<EstadoGeneral, string> = {
  saludable: 'Saludable',
  advertencia: 'Advertencia',
  critico: 'Crítico',
  'sin-datos': 'Sin datos',
}
