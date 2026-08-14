import { z } from 'zod'

/* ============================================================================
 * Configuración por entorno.
 *
 * Todo secreto entra por variable de entorno y no sale nunca de este proceso.
 * `describir()` existe para poder loguear la configuración al arrancar sin
 * filtrar el token de Coolify en el journal del contenedor.
 * ========================================================================== */

const booleano = z
  .string()
  .transform((v) => v === '1' || v.toLowerCase() === 'true')
  .pipe(z.boolean())

const esquemaEntorno = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),

  /** Cada cuánto se toma una muestra en memoria. */
  COLLECTOR_INTERVALO_MUESTRA_MS: z.coerce.number().int().min(1000).max(60_000).default(5_000),
  /** Cada cuánto se escribe a la base. Múltiplo del anterior. */
  COLLECTOR_INTERVALO_PERSISTENCIA_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .default(10_000),

  /* Raíces del host. Dentro del contenedor, el compose monta el /proc real en
   * /host/proc; sin esto el collector mediría su propio contenedor. */
  /* Identidad del host. Sin esto se deduce del machine-id de la VM; fijarla
   * sirve cuando la VM se reconstruye y se quiere conservar el historial. */
  VMSTATS_HOST_ID: z.string().default(''),

  HOST_PROC: z.string().default('/proc'),
  HOST_SYS: z.string().default('/sys'),
  HOST_ROOTFS: z.string().default(''),

  /* Docker: socket directo o proxy de sólo lectura. El compose usa el proxy. */
  DOCKER_SOCKET: z.string().default(''),
  DOCKER_PROXY_HOST: z.string().default(''),
  DOCKER_PROXY_PUERTO: z.coerce.number().int().min(1).max(65_535).default(2375),
  DOCKER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(8_000),

  /* Coolify. Ausente = la integración queda apagada, no rota. */
  COOLIFY_BASE_URL: z.string().default(''),
  COOLIFY_API_TOKEN: z.string().default(''),
  COOLIFY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  /* API interna para que web pida logs de contenedor sin tocar Docker.
   * Sin token, el servidor no arranca y la función queda apagada. */
  COLLECTOR_PUERTO_INTERNO: z.coerce.number().int().min(1).max(65_535).default(8787),
  COLLECTOR_TOKEN_INTERNO: z.string().default(''),

  /** Datos sintéticos para desarrollo. Nunca se enciende solo. */
  VMSTATS_DEMO: booleano.default(false),

  COLLECTOR_TOP_PROCESOS: z.coerce.number().int().min(3).max(50).default(10),
  COLLECTOR_VERSION: z.string().default('0.1.0'),
})

export type Entorno = z.infer<typeof esquemaEntorno>

export interface Configuracion {
  urlBase: string
  intervaloMuestraMs: number
  intervaloPersistenciaMs: number
  procfs: {
    raizProc: string
    raizSys: string
    raizFs: string
    topProcesos: number
    hostIdFijo?: string | undefined
  }
  docker:
    | { modo: 'socket'; socketPath: string; timeoutMs: number }
    | { modo: 'proxy'; host: string; puerto: number; timeoutMs: number }
    | { modo: 'apagado' }
  coolify: { habilitado: boolean; baseUrl: string; token: string; timeoutMs: number }
  interno: { habilitado: boolean; puerto: number; token: string }
  demo: boolean
  version: string
}

export function cargarConfiguracion(entorno: NodeJS.ProcessEnv = process.env): Configuracion {
  const parseado = esquemaEntorno.parse(entorno)

  // El proxy tiene prioridad: si el operador se tomó el trabajo de levantarlo,
  // es porque no quiere que el collector toque el socket directamente.
  const docker: Configuracion['docker'] =
    parseado.DOCKER_PROXY_HOST.length > 0
      ? {
          modo: 'proxy',
          host: parseado.DOCKER_PROXY_HOST,
          puerto: parseado.DOCKER_PROXY_PUERTO,
          timeoutMs: parseado.DOCKER_TIMEOUT_MS,
        }
      : parseado.DOCKER_SOCKET.length > 0
        ? {
            modo: 'socket',
            socketPath: parseado.DOCKER_SOCKET,
            timeoutMs: parseado.DOCKER_TIMEOUT_MS,
          }
        : { modo: 'apagado' }

  const coolifyHabilitado =
    parseado.COOLIFY_BASE_URL.length > 0 && parseado.COOLIFY_API_TOKEN.length > 0

  return {
    urlBase: parseado.DATABASE_URL,
    intervaloMuestraMs: parseado.COLLECTOR_INTERVALO_MUESTRA_MS,
    intervaloPersistenciaMs: parseado.COLLECTOR_INTERVALO_PERSISTENCIA_MS,
    procfs: {
      raizProc: parseado.HOST_PROC,
      raizSys: parseado.HOST_SYS,
      raizFs: parseado.HOST_ROOTFS,
      topProcesos: parseado.COLLECTOR_TOP_PROCESOS,
      ...(parseado.VMSTATS_HOST_ID.length > 0
        ? { hostIdFijo: parseado.VMSTATS_HOST_ID }
        : {}),
    },
    docker,
    coolify: {
      habilitado: coolifyHabilitado,
      baseUrl: parseado.COOLIFY_BASE_URL,
      token: parseado.COOLIFY_API_TOKEN,
      timeoutMs: parseado.COOLIFY_TIMEOUT_MS,
    },
    interno: {
      habilitado: parseado.COLLECTOR_TOKEN_INTERNO.length >= 32,
      puerto: parseado.COLLECTOR_PUERTO_INTERNO,
      token: parseado.COLLECTOR_TOKEN_INTERNO,
    },
    demo: parseado.VMSTATS_DEMO,
    version: parseado.COLLECTOR_VERSION,
  }
}

/**
 * Resumen apto para loguear.
 *
 * Ni el token de Coolify ni la contraseña de la base aparecen acá. El log del
 * contenedor lo puede leer cualquiera que tenga acceso a Coolify, así que se
 * trata como si fuera público.
 */
export function describir(config: Configuracion): Record<string, string | number | boolean> {
  return {
    base: 'configurada',
    intervaloMuestraMs: config.intervaloMuestraMs,
    intervaloPersistenciaMs: config.intervaloPersistenciaMs,
    raizProc: config.procfs.raizProc,
    docker: config.docker.modo,
    coolify: config.coolify.habilitado ? 'habilitado' : 'apagado',
    apiInterna: config.interno.habilitado ? `puerto ${config.interno.puerto}` : 'apagada',
    demo: config.demo,
    version: config.version,
  }
}
