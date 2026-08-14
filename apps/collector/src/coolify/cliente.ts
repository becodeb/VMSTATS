import { z } from 'zod'
import type { AplicacionCoolify, Despliegue, EstadoDespliegue } from '@vmstats/shared'

/* ============================================================================
 * Cliente de la API de Coolify.
 *
 * El token vive sólo en este proceso, que no expone ningún puerto. Nunca viaja
 * al navegador: la UI ve despliegues ya normalizados que salieron de la base.
 *
 * Todos los esquemas son tolerantes a propósito. La API de Coolify agrega y
 * renombra campos entre versiones menores, y un collector que se cae porque
 * apareció una propiedad nueva es peor que uno que ignora lo que no entiende.
 * ========================================================================== */

/** Sólo lectura: no hay método que dispare ni cancele un despliegue. */
const esquemaDespliegueApi = z
  .object({
    deployment_uuid: z.string(),
    application_id: z.union([z.string(), z.number()]).nullish(),
    application_name: z.string().nullish(),
    commit: z.string().nullish(),
    commit_message: z.string().nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    deployment_url: z.string().nullish(),
    server_name: z.string().nullish(),
    pull_request_id: z.number().nullish(),
    rollback: z.boolean().nullish(),
  })
  .loose()

const esquemaAplicacionApi = z
  .object({
    uuid: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    status: z.string().nullish(),
    fqdn: z.string().nullish(),
    git_branch: z.string().nullish(),
    git_repository: z.string().nullish(),
    build_pack: z.string().nullish(),
  })
  .loose()

export type DespliegueApi = z.infer<typeof esquemaDespliegueApi>
export type AplicacionApi = z.infer<typeof esquemaAplicacionApi>

/**
 * Normaliza los estados de Coolify a los nuestros.
 *
 * Coolify usa varias formas para lo mismo según la versión
 * (`cancelled-by-user`, `cancelled`), y cualquier estado desconocido cae en
 * `unknown` en vez de romper: preferimos mostrar «estado desconocido» a perder
 * el despliegue entero de la vista.
 */
export function normalizarEstadoDespliegue(estado: string | null | undefined): EstadoDespliegue {
  if (estado === null || estado === undefined) return 'unknown'
  const limpio = estado.toLowerCase().trim()

  if (limpio === 'queued' || limpio === 'pending') return 'queued'
  if (limpio === 'in_progress' || limpio === 'running' || limpio === 'building') {
    return 'in_progress'
  }
  if (limpio === 'finished' || limpio === 'success' || limpio === 'succeeded') return 'finished'
  if (limpio === 'failed' || limpio === 'error') return 'failed'
  if (limpio.startsWith('cancelled') || limpio.startsWith('canceled')) return 'cancelled'
  return 'unknown'
}

function fechaIso(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined || valor.length === 0) return null
  const fecha = new Date(valor)
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString()
}

/** Mapa uuid de aplicación -> rama, para completar lo que el deployment no trae. */
export type RamasPorAplicacion = ReadonlyMap<string, string | null>

export function normalizarDespliegue(
  crudo: DespliegueApi,
  ramas: RamasPorAplicacion,
): Despliegue {
  const estado = normalizarEstadoDespliegue(crudo.status)
  const iniciadoEn = fechaIso(crudo.created_at)
  const actualizadoEn = fechaIso(crudo.updated_at)

  // Coolify no publica `finished_at`. Para un despliegue terminado, el último
  // `updated_at` es el momento en que terminó; para uno en curso no hay final
  // todavía y decir lo contrario sería inventar.
  const terminado = estado === 'finished' || estado === 'failed' || estado === 'cancelled'
  const finalizadoEn = terminado ? actualizadoEn : null

  const duracionSegundos =
    iniciadoEn !== null && finalizadoEn !== null
      ? Math.max(0, (Date.parse(finalizadoEn) - Date.parse(iniciadoEn)) / 1000)
      : null

  const aplicacionUuid =
    crudo.application_id === null || crudo.application_id === undefined
      ? null
      : String(crudo.application_id)

  return {
    uuid: crudo.deployment_uuid,
    aplicacionUuid,
    aplicacionNombre: crudo.application_name ?? null,
    estado,
    rama: aplicacionUuid === null ? null : (ramas.get(aplicacionUuid) ?? null),
    commit: crudo.commit ?? null,
    commitMensaje: crudo.commit_message ?? null,
    iniciadoEn,
    finalizadoEn,
    duracionSegundos,
    url: esUrlValida(crudo.deployment_url) ? (crudo.deployment_url ?? null) : null,
  }
}

function esUrlValida(valor: string | null | undefined): boolean {
  if (valor === null || valor === undefined || valor.length === 0) return false
  try {
    const url = new URL(valor)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export interface OpcionesCoolify {
  baseUrl: string
  token: string
  timeoutMs: number
}

export class ErrorCoolify extends Error {
  readonly estado: number
  constructor(mensaje: string, estado: number) {
    super(mensaje)
    this.name = 'ErrorCoolify'
    this.estado = estado
  }
}

export class ClienteCoolify {
  readonly #base: string
  readonly #token: string
  readonly #timeoutMs: number

  constructor(opciones: OpcionesCoolify) {
    // La API vive bajo /api/v1; aceptamos que la URL configurada lo incluya o no.
    const limpia = opciones.baseUrl.replace(/\/+$/, '')
    this.#base = limpia.endsWith('/api/v1') ? limpia : `${limpia}/api/v1`
    this.#token = opciones.token
    this.#timeoutMs = opciones.timeoutMs
  }

  async #get<T>(ruta: string, esquema: z.ZodType<T>): Promise<T> {
    const control = new AbortController()
    const temporizador = setTimeout(() => control.abort(), this.#timeoutMs)

    try {
      const respuesta = await fetch(`${this.#base}${ruta}`, {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/json',
        },
        signal: control.signal,
      })

      if (!respuesta.ok) {
        // El cuerpo del error puede traer detalle del token; no se propaga.
        throw new ErrorCoolify(
          `Coolify respondió ${respuesta.status} en ${ruta}`,
          respuesta.status,
        )
      }

      return esquema.parse(await respuesta.json())
    } finally {
      clearTimeout(temporizador)
    }
  }

  /** Despliegues actualmente en curso. Requiere permiso `read`. */
  async desplieguesActivos(): Promise<DespliegueApi[]> {
    return this.#get('/deployments', z.array(esquemaDespliegueApi))
  }

  async aplicaciones(): Promise<AplicacionApi[]> {
    return this.#get('/applications', z.array(esquemaAplicacionApi))
  }

  /**
   * Un despliegue puntual por uuid.
   *
   * Hace falta porque `/deployments` sólo lista los que están corriendo: cuando
   * uno termina desaparece de la lista, y sin este pedido nunca sabríamos si
   * terminó bien o falló. Ver `seguimiento.ts`.
   */
  async despliegue(uuid: string): Promise<DespliegueApi | null> {
    try {
      return await this.#get(
        `/deployments/${encodeURIComponent(uuid)}`,
        esquemaDespliegueApi,
      )
    } catch (error) {
      // 404: Coolify ya lo purgó de la cola. No es un error del collector.
      if (error instanceof ErrorCoolify && error.estado === 404) return null
      throw error
    }
  }

  /** Prueba de acceso para decidir la capacidad `coolify`. */
  async accesible(): Promise<boolean> {
    try {
      await this.desplieguesActivos()
      return true
    } catch {
      return false
    }
  }
}

export function normalizarAplicacion(crudo: AplicacionApi): AplicacionCoolify {
  return {
    uuid: crudo.uuid,
    nombre: crudo.name ?? crudo.uuid,
    tipo: crudo.build_pack ?? 'desconocido',
    estado: crudo.status ?? null,
    fqdn: crudo.fqdn ?? null,
  }
}
