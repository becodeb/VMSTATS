import type { MuestraContenedor } from '@vmstats/shared'
import type { FuenteContenedores } from '../fuentes/tipos.js'
import {
  ClienteDocker,
  type ContenedorInspect,
  type ContenedorListado,
  type StatsContenedor,
} from './cliente.js'
import {
  calcularCpuContenedor,
  calcularLimiteMemoria,
  calcularMemoriaContenedor,
  identidadCoolify,
  nombreContenedor,
  normalizarEstado,
  normalizarPuertos,
  saludDesdeStatus,
  sumarBlkio,
  sumarRed,
} from './normalizar.js'

/* ============================================================================
 * Muestreo de contenedores.
 *
 * Igual que con el host: Docker publica contadores acumulados y las tasas
 * salen de restar la lectura anterior. Se usa `one-shot=true` justamente para
 * eso — sin `one-shot`, Docker se queda un segundo esperando para calcular él
 * mismo el delta, y con treinta contenedores eso es medio ciclo perdido.
 * ========================================================================== */

interface EstadoPrevio {
  en: number
  stats: StatsContenedor
}

export interface OpcionesFuenteContenedores {
  /** Cada cuántos ciclos refrescar el `inspect` (reinicios, arranque). */
  ciclosPorInspect: number
  /** Tope de contenedores a muestrear por ciclo. */
  maxContenedores: number
}

export const OPCIONES_CONTENEDORES_POR_DEFECTO: OpcionesFuenteContenedores = {
  ciclosPorInspect: 6,
  maxContenedores: 100,
}

export class FuenteDocker implements FuenteContenedores {
  readonly #cliente: ClienteDocker
  readonly #opciones: OpcionesFuenteContenedores
  readonly #previos = new Map<string, EstadoPrevio>()
  readonly #inspecciones = new Map<string, ContenedorInspect>()
  #hostId: string
  #memoriaTotalHost = 0
  #disponible = false
  #ciclo = 0

  constructor(
    cliente: ClienteDocker,
    hostId: string,
    opciones: Partial<OpcionesFuenteContenedores> = {},
  ) {
    this.#cliente = cliente
    this.#hostId = hostId
    this.#opciones = { ...OPCIONES_CONTENEDORES_POR_DEFECTO, ...opciones }
  }

  disponible(): boolean {
    return this.#disponible
  }

  /** La memoria total del host permite detectar contenedores «sin límite». */
  fijarMemoriaHost(bytes: number): void {
    this.#memoriaTotalHost = bytes
  }

  fijarHostId(hostId: string): void {
    this.#hostId = hostId
  }

  async comprobarAcceso(): Promise<boolean> {
    this.#disponible = await this.#cliente.disponible()
    return this.#disponible
  }

  async muestrear(): Promise<MuestraContenedor[]> {
    let listado: ContenedorListado[]
    try {
      listado = await this.#cliente.getJson<ContenedorListado[]>('/containers/json?all=true')
      this.#disponible = true
    } catch {
      // Docker caído o sin permisos: no es fatal para el collector, el resto
      // de las métricas siguen. La UI muestra la sección como no disponible.
      this.#disponible = false
      return []
    }

    this.#ciclo += 1
    const refrescarInspect = this.#ciclo % this.#opciones.ciclosPorInspect === 1

    const activos = listado.slice(0, this.#opciones.maxContenedores)
    const vivos = new Set(activos.map((c) => c.Id))

    // Contenedor que desapareció: fuera del estado previo, para no filtrar
    // memoria en un proceso que corre durante meses.
    for (const id of this.#previos.keys()) {
      if (!vivos.has(id)) this.#previos.delete(id)
    }
    for (const id of this.#inspecciones.keys()) {
      if (!vivos.has(id)) this.#inspecciones.delete(id)
    }

    const ahora = Date.now()
    const ts = new Date(ahora).toISOString()

    const muestras = await Promise.all(
      activos.map(async (contenedor): Promise<MuestraContenedor | null> => {
        // Un contenedor parado no tiene stats que pedir, pero sí queremos
        // mostrarlo en la lista: por eso se emite igual, en cero.
        const corriendo = contenedor.State === 'running'

        let stats: StatsContenedor | null = null
        if (corriendo) {
          try {
            stats = await this.#cliente.getJson<StatsContenedor>(
              `/containers/${encodeURIComponent(contenedor.Id)}/stats?stream=false&one-shot=true`,
            )
          } catch {
            stats = null
          }
        }

        if (refrescarInspect || !this.#inspecciones.has(contenedor.Id)) {
          try {
            const inspect = await this.#cliente.getJson<ContenedorInspect>(
              `/containers/${encodeURIComponent(contenedor.Id)}/json`,
            )
            this.#inspecciones.set(contenedor.Id, inspect)
          } catch {
            // Sin inspect perdemos reinicios y arranque exacto, no la muestra.
          }
        }

        const inspect = this.#inspecciones.get(contenedor.Id)
        const previo = this.#previos.get(contenedor.Id)
        const segundos = previo === undefined ? 0 : (ahora - previo.en) / 1000

        if (stats !== null) this.#previos.set(contenedor.Id, { en: ahora, stats })

        const identidad = identidadCoolify(contenedor.Labels)
        const red = sumarRed(stats?.networks)
        const bloque = sumarBlkio(stats?.blkio_stats)
        const redPrevia = sumarRed(previo?.stats.networks)
        const bloquePrevio = sumarBlkio(previo?.stats.blkio_stats)

        const tasa = (actual: number, anterior: number): number => {
          if (segundos <= 0 || previo === undefined) return 0
          const d = actual - anterior
          return d < 0 ? 0 : d / segundos
        }

        const arranque = inspect?.State.StartedAt
        const uptime =
          arranque === undefined || !corriendo
            ? 0
            : Math.max(0, (ahora - new Date(arranque).getTime()) / 1000)

        return {
          hostId: this.#hostId,
          contenedorId: contenedor.Id,
          ts,
          nombre: nombreContenedor(contenedor.Names),
          imagen: contenedor.Image,
          estado: normalizarEstado(contenedor.State),
          salud: saludDesdeStatus(contenedor.Status),
          cpuPorcentaje:
            stats === null
              ? 0
              : calcularCpuContenedor(
                  stats.cpu_stats,
                  previo?.stats.cpu_stats ?? null,
                  segundos,
                ),
          memoriaBytes: stats === null ? 0 : calcularMemoriaContenedor(stats.memory_stats),
          memoriaLimiteBytes:
            stats === null
              ? null
              : calcularLimiteMemoria(stats.memory_stats, this.#memoriaTotalHost),
          redRxBytesPorSeg: tasa(red.rx, redPrevia.rx),
          redTxBytesPorSeg: tasa(red.tx, redPrevia.tx),
          bloqueLecturaBytesPorSeg: tasa(bloque.lectura, bloquePrevio.lectura),
          bloqueEscrituraBytesPorSeg: tasa(bloque.escritura, bloquePrevio.escritura),
          uptimeSegundos: Number.isFinite(uptime) ? uptime : 0,
          reinicios: inspect?.RestartCount ?? 0,
          puertos: normalizarPuertos(contenedor.Ports),
          coolifyAplicacion: identidad.aplicacion,
          coolifyUuid: identidad.uuid,
        }
      }),
    )

    return muestras.filter((m): m is MuestraContenedor => m !== null)
  }
}
