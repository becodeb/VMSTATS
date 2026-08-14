import { z } from 'zod'

/* ============================================================================
 * Contenedores Docker, leídos por el collector vía Engine API de sólo lectura.
 * ========================================================================== */

export const ESTADOS_CONTENEDOR = [
  'running',
  'paused',
  'restarting',
  'exited',
  'created',
  'removing',
  'dead',
] as const
export const esquemaEstadoContenedor = z.enum(ESTADOS_CONTENEDOR)
export type EstadoContenedor = z.infer<typeof esquemaEstadoContenedor>

/** `none` = la imagen no declara HEALTHCHECK. No es lo mismo que sano. */
export const ESTADOS_SALUD = ['healthy', 'unhealthy', 'starting', 'none'] as const
export const esquemaEstadoSalud = z.enum(ESTADOS_SALUD)
export type EstadoSalud = z.infer<typeof esquemaEstadoSalud>

export const esquemaPuerto = z.object({
  privado: z.number().int().min(0),
  publico: z.number().int().min(0).nullable(),
  protocolo: z.string(),
  ip: z.string().nullable(),
})
export type Puerto = z.infer<typeof esquemaPuerto>

export const esquemaMuestraContenedor = z.object({
  hostId: z.string(),
  contenedorId: z.string(),
  ts: z.iso.datetime(),
  nombre: z.string(),
  imagen: z.string(),
  estado: esquemaEstadoContenedor,
  salud: esquemaEstadoSalud,
  cpuPorcentaje: z.number().min(0),
  memoriaBytes: z.number().min(0),
  /** null cuando el contenedor corre sin límite: mostrar "sin límite", no 0. */
  memoriaLimiteBytes: z.number().min(0).nullable(),
  redRxBytesPorSeg: z.number().min(0),
  redTxBytesPorSeg: z.number().min(0),
  bloqueLecturaBytesPorSeg: z.number().min(0),
  bloqueEscrituraBytesPorSeg: z.number().min(0),
  uptimeSegundos: z.number().min(0),
  reinicios: z.number().int().min(0),
  puertos: z.array(esquemaPuerto),
  /** Nombre de la aplicación de Coolify dueña del contenedor, si se pudo
   *  deducir de las labels. */
  coolifyAplicacion: z.string().nullable(),
  coolifyUuid: z.string().nullable(),
})
export type MuestraContenedor = z.infer<typeof esquemaMuestraContenedor>

export const esquemaLineaLog = z.object({
  ts: z.iso.datetime().nullable(),
  flujo: z.enum(['stdout', 'stderr']),
  texto: z.string(),
})
export type LineaLog = z.infer<typeof esquemaLineaLog>

export const esquemaLogsContenedor = z.object({
  contenedorId: z.string(),
  lineas: z.array(esquemaLineaLog),
  /** true si se cortó por el tope de líneas o de bytes. */
  truncado: z.boolean(),
  /** Cuántos fragmentos se reemplazaron por «[redactado]». Se muestra para que
   *  nadie crea que está viendo el log crudo. */
  redacciones: z.number().int().min(0),
})
export type LogsContenedor = z.infer<typeof esquemaLogsContenedor>
