import { z } from 'zod'

/* ============================================================================
 * Despliegues de Coolify.
 *
 * Coolify no publica un porcentaje de avance, así que acá tampoco existe: el
 * progreso es la fase real informada por la API, y en la UI se dibuja como
 * indeterminado. Inventar un 60% sería mentira con forma de dato.
 * ========================================================================== */

export const ESTADOS_DESPLIEGUE = [
  'queued',
  'in_progress',
  'finished',
  'failed',
  'cancelled',
  'unknown',
] as const
export const esquemaEstadoDespliegue = z.enum(ESTADOS_DESPLIEGUE)
export type EstadoDespliegue = z.infer<typeof esquemaEstadoDespliegue>

/** Estados en los que el despliegue todavía está ocupando la VM. */
export const ESTADOS_ACTIVOS: readonly EstadoDespliegue[] = ['queued', 'in_progress']

export function esDespliegueActivo(estado: EstadoDespliegue): boolean {
  return ESTADOS_ACTIVOS.includes(estado)
}

export const esquemaDespliegue = z.object({
  /** UUID del deployment en Coolify: es la clave de idempotencia con la que
   *  el collector evita duplicar eventos al reiniciar. */
  uuid: z.string(),
  aplicacionUuid: z.string().nullable(),
  aplicacionNombre: z.string().nullable(),
  estado: esquemaEstadoDespliegue,
  rama: z.string().nullable(),
  commit: z.string().nullable(),
  commitMensaje: z.string().nullable(),
  iniciadoEn: z.iso.datetime().nullable(),
  finalizadoEn: z.iso.datetime().nullable(),
  duracionSegundos: z.number().min(0).nullable(),
  /** URL al despliegue en Coolify, sólo si la API la provee. */
  url: z.url().nullable(),
})
export type Despliegue = z.infer<typeof esquemaDespliegue>

/** Un cambio de estado observado. El collector sólo guarda transiciones, no
 *  cada respuesta del polling. */
export const esquemaEventoDespliegue = z.object({
  id: z.number().int(),
  despliegueUuid: z.string(),
  estado: esquemaEstadoDespliegue,
  estadoAnterior: esquemaEstadoDespliegue.nullable(),
  observadoEn: z.iso.datetime(),
  aplicacionNombre: z.string().nullable(),
  rama: z.string().nullable(),
  commit: z.string().nullable(),
  commitMensaje: z.string().nullable(),
})
export type EventoDespliegue = z.infer<typeof esquemaEventoDespliegue>

export const esquemaAplicacionCoolify = z.object({
  uuid: z.string(),
  nombre: z.string(),
  tipo: z.string(),
  estado: z.string().nullable(),
  fqdn: z.string().nullable(),
})
export type AplicacionCoolify = z.infer<typeof esquemaAplicacionCoolify>
