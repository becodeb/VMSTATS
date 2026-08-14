import http from 'node:http'
import { Buffer } from 'node:buffer'

/* ============================================================================
 * Cliente del Docker Engine API.
 *
 * Escrito a mano sobre node:http en vez de usar dockerode por dos razones: hace
 * falta hablar por socket Unix *y* por TCP (el proxy de sólo lectura), y porque
 * este cliente sólo sabe hacer GET.
 *
 * Eso último es a propósito y es una defensa, no una limitación: no existe en
 * este código un camino que cree, borre, reinicie o ejecute nada en un
 * contenedor. La spec lo prohíbe y la forma más confiable de cumplirlo es no
 * escribir el método. Ver docs/security.md.
 * ========================================================================== */

export interface OpcionesDocker {
  /** Ruta al socket Unix, p. ej. `/var/run/docker.sock`. */
  socketPath?: string
  /** Host y puerto del proxy de sólo lectura. Excluyente con `socketPath`. */
  host?: string
  puerto?: number
  /** Corta la lectura para que un Docker colgado no bloquee el ciclo. */
  timeoutMs: number
}

export class ErrorDocker extends Error {
  readonly estado: number
  constructor(mensaje: string, estado: number) {
    super(mensaje)
    this.name = 'ErrorDocker'
    this.estado = estado
  }
}

export class ClienteDocker {
  readonly #opciones: OpcionesDocker

  constructor(opciones: OpcionesDocker) {
    if (opciones.socketPath === undefined && opciones.host === undefined) {
      throw new Error('ClienteDocker necesita socketPath o host')
    }
    this.#opciones = opciones
  }

  /** Sólo GET. No hay equivalente para POST, DELETE ni ninguna mutación. */
  async #get(ruta: string, limiteBytes = 8 * 1024 * 1024): Promise<Buffer> {
    const { socketPath, host, puerto, timeoutMs } = this.#opciones

    return new Promise((resolver, rechazar) => {
      const peticion = http.request(
        {
          ...(socketPath === undefined ? {} : { socketPath }),
          ...(host === undefined ? {} : { host, port: puerto ?? 2375 }),
          path: ruta,
          method: 'GET',
          timeout: timeoutMs,
          headers: { Accept: 'application/json' },
        },
        (respuesta) => {
          const partes: Buffer[] = []
          let total = 0

          respuesta.on('data', (parte: Buffer) => {
            total += parte.length
            // Un contenedor que escupe gigabytes de log no puede voltear al
            // collector: se corta la conexión y se devuelve lo leído.
            if (total > limiteBytes) {
              respuesta.destroy()
              return
            }
            partes.push(parte)
          })

          respuesta.on('end', () => {
            const cuerpo = Buffer.concat(partes)
            const estado = respuesta.statusCode ?? 0
            if (estado >= 400) {
              rechazar(
                new ErrorDocker(
                  `Docker respondió ${estado} en ${ruta}: ${cuerpo.toString('utf8').slice(0, 200)}`,
                  estado,
                ),
              )
              return
            }
            resolver(cuerpo)
          })

          respuesta.on('close', () => {
            if (total > limiteBytes) resolver(Buffer.concat(partes))
          })
        },
      )

      peticion.on('timeout', () => {
        peticion.destroy(new Error(`Timeout de ${timeoutMs} ms consultando ${ruta}`))
      })
      peticion.on('error', rechazar)
      peticion.end()
    })
  }

  async getJson<T>(ruta: string): Promise<T> {
    const cuerpo = await this.#get(ruta)
    return JSON.parse(cuerpo.toString('utf8')) as T
  }

  async getCrudo(ruta: string, limiteBytes: number): Promise<Buffer> {
    return this.#get(ruta, limiteBytes)
  }

  /** Ping barato: sirve para decidir si la capacidad `contenedores` existe. */
  async disponible(): Promise<boolean> {
    try {
      await this.getJson<unknown>('/_ping')
      return true
    } catch {
      try {
        await this.getJson<unknown>('/version')
        return true
      } catch {
        return false
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * Tipos de la API que efectivamente usamos
 * ---------------------------------------------------------------------- */

export interface PuertoDocker {
  IP?: string
  PrivatePort: number
  PublicPort?: number
  Type: string
}

/* Varios campos llegan `null` y no como colección vacía — `Ports` es el caso
 * más habitual, en cualquier contenedor sin puertos publicados. Se descubrió
 * corriendo contra un Docker real: con el tipo optimista, el collector se caía
 * en cada ciclo. */
export interface ContenedorListado {
  Id: string
  Names: string[] | null
  Image: string
  State: string
  /** Texto tipo «Up 2 hours (healthy)». De acá sale la salud sin un inspect. */
  Status: string
  Created: number
  Ports: PuertoDocker[] | null
  Labels: Record<string, string> | null
}

export interface UsoCpuDocker {
  total_usage: number
}

export interface StatsCpuDocker {
  cpu_usage: UsoCpuDocker
  system_cpu_usage?: number
  online_cpus?: number
}

export interface StatsMemoriaDocker {
  usage?: number
  limit?: number
  stats?: Record<string, number>
}

export interface StatsRedDocker {
  rx_bytes: number
  tx_bytes: number
}

export interface EntradaBlkio {
  op: string
  value: number
}

export interface StatsBlkioDocker {
  io_service_bytes_recursive?: EntradaBlkio[] | null
}

export interface StatsContenedor {
  read: string
  cpu_stats: StatsCpuDocker
  precpu_stats?: StatsCpuDocker
  memory_stats: StatsMemoriaDocker
  networks?: Record<string, StatsRedDocker>
  blkio_stats?: StatsBlkioDocker
}

export interface EstadoInspect {
  Status: string
  StartedAt: string
  Health?: { Status: string }
}

export interface ContenedorInspect {
  Id: string
  RestartCount: number
  State: EstadoInspect
}
