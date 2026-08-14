import { z } from 'zod'

/* ============================================================================
 * Métricas del host.
 *
 * Todo lo que el kernel puede no exponer va como `nullable`, nunca como
 * opcional: la diferencia entre "no lo medimos" y "vale cero" es información
 * que la UI tiene que mostrar como «No disponible». Un `0` inventado en un
 * panel de infraestructura es peor que un hueco.
 * ========================================================================== */

const porcentaje = z.number().min(0).max(100)
const bytes = z.number().min(0)
const porSegundo = z.number().min(0)

/** Reparto del tiempo de CPU, en porcentaje del intervalo medido. */
export const esquemaCpu = z.object({
  /** 100 - idle. Es lo que se muestra como "uso de CPU". */
  total: porcentaje,
  user: porcentaje,
  system: porcentaje,
  nice: porcentaje,
  idle: porcentaje,
  iowait: porcentaje,
  irq: porcentaje,
  softirq: porcentaje,
  /** Tiempo robado por el hipervisor. En una VM es la métrica que delata
   *  vecinos ruidosos, así que la tratamos como de primera clase. */
  steal: porcentaje,
  /** Uso por núcleo, mismo criterio que `total`. */
  porNucleo: z.array(porcentaje),
})
export type Cpu = z.infer<typeof esquemaCpu>

export const esquemaCarga = z.object({
  uno: z.number().min(0),
  cinco: z.number().min(0),
  quince: z.number().min(0),
  /** Cores disponibles: sin esto el load average no se puede interpretar. */
  nucleos: z.number().int().min(1),
})
export type Carga = z.infer<typeof esquemaCarga>

export const esquemaMemoria = z.object({
  total: bytes,
  /** total - available. Es el "usado" que le importa a un operador, no el
   *  `MemTotal - MemFree` que cuenta cache como ocupada. */
  usada: bytes,
  disponible: bytes,
  libre: bytes,
  cache: bytes,
  buffers: bytes,
  swapTotal: bytes,
  swapUsada: bytes,
})
export type Memoria = z.infer<typeof esquemaMemoria>

export const esquemaFilesystem = z.object({
  puntoMontaje: z.string(),
  dispositivo: z.string(),
  tipo: z.string(),
  tamanio: bytes,
  usado: bytes,
  disponible: bytes,
  inodosTotal: z.number().min(0).nullable(),
  inodosUsados: z.number().min(0).nullable(),
})
export type Filesystem = z.infer<typeof esquemaFilesystem>

export const esquemaDisco = z.object({
  dispositivo: z.string(),
  lecturaBytesPorSeg: porSegundo,
  escrituraBytesPorSeg: porSegundo,
  lecturaOpsPorSeg: porSegundo,
  escrituraOpsPorSeg: porSegundo,
  /** Fracción del intervalo con al menos una operación en vuelo (0-100). */
  utilizacion: porcentaje.nullable(),
  /** Latencia media por operación. Necesita los campos extendidos de
   *  /proc/diskstats; en kernels viejos o dispositivos virtuales falta. */
  latenciaLecturaMs: z.number().min(0).nullable(),
  latenciaEscrituraMs: z.number().min(0).nullable(),
})
export type Disco = z.infer<typeof esquemaDisco>

export const esquemaInterfazRed = z.object({
  interfaz: z.string(),
  rxBytesPorSeg: porSegundo,
  txBytesPorSeg: porSegundo,
  rxPaquetesPorSeg: porSegundo,
  txPaquetesPorSeg: porSegundo,
  rxErrores: z.number().min(0),
  txErrores: z.number().min(0),
  rxDescartes: z.number().min(0),
  txDescartes: z.number().min(0),
})
export type InterfazRed = z.infer<typeof esquemaInterfazRed>

export const esquemaTcp = z.object({
  establecidas: z.number().int().min(0),
  escuchando: z.number().int().min(0),
  timeWait: z.number().int().min(0),
  total: z.number().int().min(0),
})
export type Tcp = z.infer<typeof esquemaTcp>

export const esquemaProceso = z.object({
  pid: z.number().int().min(0),
  /** Solo el comando, sin argumentos: los argumentos filtran tokens y
   *  contraseñas con demasiada facilidad. Ver docs/security.md. */
  comando: z.string(),
  usuario: z.string(),
  cpuPorcentaje: z.number().min(0),
  memoriaBytes: bytes,
})
export type Proceso = z.infer<typeof esquemaProceso>

/** Una línea de /proc/pressure/*: cuánto tiempo hubo tareas demoradas. */
export const esquemaPresionRecurso = z.object({
  some10: porcentaje,
  some60: porcentaje,
  some300: porcentaje,
  full10: porcentaje.nullable(),
  full60: porcentaje.nullable(),
  full300: porcentaje.nullable(),
})
export type PresionRecurso = z.infer<typeof esquemaPresionRecurso>

export const esquemaPresion = z.object({
  cpu: esquemaPresionRecurso.nullable(),
  memoria: esquemaPresionRecurso.nullable(),
  io: esquemaPresionRecurso.nullable(),
})
export type Presion = z.infer<typeof esquemaPresion>

export const esquemaTemperatura = z.object({
  etiqueta: z.string(),
  celsius: z.number(),
  criticaCelsius: z.number().nullable(),
})
export type Temperatura = z.infer<typeof esquemaTemperatura>

export const esquemaSistema = z.object({
  hostname: z.string(),
  kernel: z.string(),
  distribucion: z.string(),
  arquitectura: z.string(),
  nucleos: z.number().int().min(1),
})
export type Sistema = z.infer<typeof esquemaSistema>

/**
 * Qué pudo leer efectivamente el collector en esta VM.
 *
 * La UI usa esto para distinguir «no disponible en este host» de «todavía no
 * llegó la muestra». Sin esta distinción un panel vacío es ambiguo.
 */
export const esquemaCapacidades = z.object({
  presion: z.boolean(),
  temperatura: z.boolean(),
  ioDisco: z.boolean(),
  latenciaIo: z.boolean(),
  procesos: z.boolean(),
  contenedores: z.boolean(),
  coolify: z.boolean(),
})
export type Capacidades = z.infer<typeof esquemaCapacidades>

/** El paquete completo que el collector arma en cada muestra. */
export const esquemaMuestraHost = z.object({
  hostId: z.string(),
  /** UTC siempre. La zona de visualización es una preferencia de la UI. */
  ts: z.iso.datetime(),
  cpu: esquemaCpu,
  carga: esquemaCarga,
  memoria: esquemaMemoria,
  uptimeSegundos: z.number().min(0),
  filesystems: z.array(esquemaFilesystem),
  discos: z.array(esquemaDisco),
  red: z.array(esquemaInterfazRed),
  tcp: esquemaTcp.nullable(),
  procesos: z.array(esquemaProceso),
  presion: esquemaPresion,
  temperaturas: z.array(esquemaTemperatura),
  sistema: esquemaSistema,
  capacidades: esquemaCapacidades,
})
export type MuestraHost = z.infer<typeof esquemaMuestraHost>
