import { z } from 'zod'
import { esquemaMuestraHost } from './host.js'
import { esquemaMuestraContenedor } from './contenedores.js'
import { esquemaDespliegue, esquemaEventoDespliegue } from './despliegues.js'
import { esquemaInstanciaAlerta } from './alertas.js'
import { esquemaResolucion, CLAVES_RANGO } from './tiempo.js'

/* ============================================================================
 * Contratos de la frontera HTTP: SSE y REST.
 *
 * Todo lo que cruza la red se valida con estos esquemas de los dos lados. El
 * cliente no confía en el servidor más de lo que el servidor confía en el
 * cliente: si el collector escribió basura, la UI lo detecta acá y no dibuja
 * un gráfico con NaN.
 * ========================================================================== */

/** La foto completa del sistema en un instante. Es el payload del SSE. */
export const esquemaInstantanea = z.object({
  host: esquemaMuestraHost.nullable(),
  contenedores: z.array(esquemaMuestraContenedor),
  desplieguesActivos: z.array(esquemaDespliegue),
  alertasAbiertas: z.array(esquemaInstanciaAlerta),
  generadoEn: z.iso.datetime(),
  /** Cuándo reportó el collector por última vez. La UI lo compara contra su
   *  propio reloj para decidir si muestra «Datos desactualizados». */
  ultimoLatido: z.iso.datetime().nullable(),
})
export type Instantanea = z.infer<typeof esquemaInstantanea>

/* -------------------------------------------------------------------------
 * SSE
 * ---------------------------------------------------------------------- */

export const EVENTOS_SSE = ['instantanea', 'despliegue', 'alerta', 'latido'] as const
export type EventoSse = (typeof EVENTOS_SSE)[number]

export const esquemaLatido = z.object({
  ts: z.iso.datetime(),
  /** Id monotónico del último evento emitido, para reanudar con Last-Event-ID. */
  ultimoId: z.number().int().min(0),
})
export type Latido = z.infer<typeof esquemaLatido>

/** Cada 20 s: mantiene viva la conexión a través de proxies que cortan por
 *  inactividad, y le da al cliente una señal de vida independiente del dato. */
export const INTERVALO_LATIDO_MS = 20_000

/* -------------------------------------------------------------------------
 * Historial
 * ---------------------------------------------------------------------- */

/** Series consultables. La clave viaja tal cual en la query. */
export const SERIES_HISTORIAL = {
  'cpu.total': { etiqueta: 'CPU', unidad: '%' },
  'cpu.user': { etiqueta: 'CPU usuario', unidad: '%' },
  'cpu.system': { etiqueta: 'CPU sistema', unidad: '%' },
  'cpu.iowait': { etiqueta: 'CPU iowait', unidad: '%' },
  'cpu.steal': { etiqueta: 'CPU robada', unidad: '%' },
  'carga.uno': { etiqueta: 'Load 1m', unidad: '' },
  'carga.cinco': { etiqueta: 'Load 5m', unidad: '' },
  'carga.quince': { etiqueta: 'Load 15m', unidad: '' },
  'memoria.usada': { etiqueta: 'Memoria usada', unidad: 'B' },
  'memoria.disponible': { etiqueta: 'Memoria disponible', unidad: 'B' },
  'memoria.cache': { etiqueta: 'Cache', unidad: 'B' },
  'memoria.swapUsada': { etiqueta: 'Swap usada', unidad: 'B' },
  'red.rx': { etiqueta: 'Red entrante', unidad: 'B/s' },
  'red.tx': { etiqueta: 'Red saliente', unidad: 'B/s' },
  'disco.lectura': { etiqueta: 'Lectura de disco', unidad: 'B/s' },
  'disco.escritura': { etiqueta: 'Escritura de disco', unidad: 'B/s' },
  'presion.cpu': { etiqueta: 'Presión CPU', unidad: '%' },
  'presion.memoria': { etiqueta: 'Presión memoria', unidad: '%' },
  'presion.io': { etiqueta: 'Presión I/O', unidad: '%' },
  'tcp.establecidas': { etiqueta: 'Conexiones TCP', unidad: '' },
} as const

export type ClaveSerie = keyof typeof SERIES_HISTORIAL
export const CLAVES_SERIE = Object.keys(SERIES_HISTORIAL) as [ClaveSerie, ...ClaveSerie[]]
export const esquemaClaveSerie = z.enum(CLAVES_SERIE)

export const esquemaConsultaHistorial = z
  .object({
    /** Alternativa cómoda a desde/hasta para los botones de rango. */
    rango: z.enum(CLAVES_RANGO).optional(),
    desde: z.iso.datetime().optional(),
    hasta: z.iso.datetime().optional(),
    /** Lista separada por comas en la query string. */
    series: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(esquemaClaveSerie).min(1).max(12)),
    hostId: z.string().optional(),
  })
  .refine((v) => v.rango !== undefined || (v.desde !== undefined && v.hasta !== undefined), {
    message: 'Hace falta `rango`, o bien `desde` y `hasta`',
  })
export type ConsultaHistorial = z.infer<typeof esquemaConsultaHistorial>

/** Punto de serie: `[msEpoch, valor]`. `null` = hueco real en los datos, que
 *  el gráfico dibuja como interrupción y no como una línea recta inventada. */
export const esquemaPunto = z.tuple([z.number(), z.number().nullable()])
export type Punto = z.infer<typeof esquemaPunto>

export const esquemaSerie = z.object({
  clave: esquemaClaveSerie,
  etiqueta: z.string(),
  unidad: z.string(),
  puntos: z.array(esquemaPunto),
})
export type Serie = z.infer<typeof esquemaSerie>

export const esquemaRespuestaHistorial = z.object({
  desde: z.iso.datetime(),
  hasta: z.iso.datetime(),
  resolucion: esquemaResolucion,
  bucketSegundos: z.number().int().min(1),
  degradado: z.boolean(),
  series: z.array(esquemaSerie),
})
export type RespuestaHistorial = z.infer<typeof esquemaRespuestaHistorial>

/* -------------------------------------------------------------------------
 * Despliegues, contenedores, alertas
 * ---------------------------------------------------------------------- */

export const esquemaConsultaDespliegues = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  desde: z.iso.datetime().optional(),
  hasta: z.iso.datetime().optional(),
})
export type ConsultaDespliegues = z.infer<typeof esquemaConsultaDespliegues>

export const esquemaRespuestaDespliegues = z.object({
  activos: z.array(esquemaDespliegue),
  recientes: z.array(esquemaDespliegue),
  eventos: z.array(esquemaEventoDespliegue),
})
export type RespuestaDespliegues = z.infer<typeof esquemaRespuestaDespliegues>

export const esquemaConsultaLogs = z.object({
  lineas: z.coerce.number().int().min(10).max(1000).default(200),
})
export type ConsultaLogs = z.infer<typeof esquemaConsultaLogs>

export const esquemaReconocerAlerta = z.object({
  instanciaId: z.number().int(),
})

export const esquemaSilenciarRegla = z.object({
  reglaId: z.number().int(),
  minutos: z.number().int().min(1).max(10_080),
})

/* -------------------------------------------------------------------------
 * Preferencias y errores
 * ---------------------------------------------------------------------- */

export const esquemaPreferencias = z.object({
  zonaHoraria: z.string().min(1).max(64),
  retencionRawDias: z.number().int().min(1).max(90),
  retencionUnMinutoDias: z.number().int().min(1).max(400),
  retencionCincoMinutosDias: z.number().int().min(1).max(1200),
  logsHabilitados: z.boolean(),
})
export type Preferencias = z.infer<typeof esquemaPreferencias>

/**
 * Error de API.
 *
 * `codigo` es estable y apto para la UI; `mensaje` es una frase para humanos.
 * Nunca lleva stack ni detalle interno: eso va al log del servidor. Ver
 * docs/security.md.
 */
export const esquemaError = z.object({
  codigo: z.enum([
    'no_autenticado',
    'sin_permiso',
    'csrf_invalido',
    'entrada_invalida',
    'no_encontrado',
    'demasiados_intentos',
    'dependencia_caida',
    'no_disponible',
    'error_interno',
  ]),
  mensaje: z.string(),
})
export type ErrorApi = z.infer<typeof esquemaError>
