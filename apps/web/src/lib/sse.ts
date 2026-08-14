import { desc } from 'drizzle-orm'
import pg from 'pg'
import {
  CANAL_ALERTA,
  CANAL_DESPLIEGUE,
  CANAL_INSTANTANEA,
  alertasAbiertas,
  instantaneas,
  latidosCollector,
} from '@vmstats/db'
import { esquemaInstantanea, type EventoSse, type Instantanea } from '@vmstats/shared'
import { desplieguesActivos } from './despliegues.js'
import { base } from './base.js'
import { entorno } from './entorno.js'

/* ============================================================================
 * Bus de tiempo real.
 *
 * El collector no habla con este proceso: escribe en `live_snapshots` y hace
 * `pg_notify`. Acá hay UNA conexión dedicada a Postgres en modo LISTEN — fuera
 * del pool, porque una conexión en LISTEN queda ocupada indefinidamente y
 * devolverla al pool la rompería — y desde esa única conexión se abanica a
 * todos los navegadores conectados.
 *
 * Con diez pestañas abiertas sigue habiendo una sola conexión escuchando, no
 * diez consultas periódicas.
 * ========================================================================== */

export interface EventoEmitido {
  id: number
  tipo: EventoSse
  datos: unknown
}

type Suscriptor = (evento: EventoEmitido) => void

/**
 * Historial corto para reanudar con `Last-Event-ID`.
 *
 * Sesenta eventos son unos diez minutos de instantáneas. Alcanza para un túnel
 * que se cortó un momento; una desconexión más larga se resuelve con una
 * instantánea fresca, que es más barato que guardar horas de historial.
 */
const TAMANIO_HISTORIAL = 60

class Hub {
  readonly #suscriptores = new Set<Suscriptor>()
  readonly #historial: EventoEmitido[] = []
  #cliente: pg.Client | null = null
  #conectando: Promise<void> | null = null
  #proximoId = 1
  #reintentos = 0

  get conectados(): number {
    return this.#suscriptores.size
  }

  async suscribir(entregar: Suscriptor): Promise<() => void> {
    await this.#asegurarConexion()
    this.#suscriptores.add(entregar)
    return () => {
      this.#suscriptores.delete(entregar)
    }
  }

  /** Eventos posteriores a un id dado, para reanudar sin huecos. */
  desde(ultimoId: number): EventoEmitido[] {
    return this.#historial.filter((e) => e.id > ultimoId)
  }

  get ultimoId(): number {
    return this.#proximoId - 1
  }

  emitir(tipo: EventoSse, datos: unknown): EventoEmitido {
    const evento: EventoEmitido = { id: this.#proximoId, tipo, datos }
    this.#proximoId += 1

    // El latido no entra al historial: reenviar latidos viejos al reconectar no
    // le sirve a nadie y desplazaría eventos con contenido real.
    if (tipo !== 'latido') {
      this.#historial.push(evento)
      if (this.#historial.length > TAMANIO_HISTORIAL) this.#historial.shift()
    }

    for (const suscriptor of this.#suscriptores) {
      try {
        suscriptor(evento)
      } catch {
        // Un suscriptor con el socket ya cerrado no puede tumbar al resto.
      }
    }

    return evento
  }

  async #asegurarConexion(): Promise<void> {
    if (this.#cliente !== null) return
    if (this.#conectando !== null) return this.#conectando

    this.#conectando = this.#conectar()
    try {
      await this.#conectando
    } finally {
      this.#conectando = null
    }
  }

  async #conectar(): Promise<void> {
    const cliente = new pg.Client({ connectionString: entorno().DATABASE_URL })

    cliente.on('notification', (aviso) => {
      void this.#alNotificar(aviso.channel)
    })

    cliente.on('error', (causa) => {
      console.error('[sse] la conexión LISTEN falló:', causa.message)
      this.#cliente = null
      void this.#reconectar()
    })

    await cliente.connect()
    await cliente.query(`LISTEN ${CANAL_INSTANTANEA}`)
    await cliente.query(`LISTEN ${CANAL_DESPLIEGUE}`)
    await cliente.query(`LISTEN ${CANAL_ALERTA}`)

    this.#cliente = cliente
    this.#reintentos = 0
  }

  /** Backoff exponencial con techo de 30 s. */
  async #reconectar(): Promise<void> {
    if (this.#suscriptores.size === 0) return

    this.#reintentos += 1
    const espera = Math.min(30_000, 1000 * 2 ** (this.#reintentos - 1))

    setTimeout(() => {
      void this.#asegurarConexion().catch(() => {
        void this.#reconectar()
      })
    }, espera)
  }

  async #alNotificar(canal: string): Promise<void> {
    try {
      if (canal === CANAL_INSTANTANEA) {
        const foto = await leerInstantanea()
        if (foto !== null) this.emitir('instantanea', foto)
      } else if (canal === CANAL_DESPLIEGUE) {
        this.emitir('despliegue', { activos: await desplieguesActivos(base()) })
      } else if (canal === CANAL_ALERTA) {
        this.emitir('alerta', { abiertas: await alertasAbiertas(base()) })
      }
    } catch (causa) {
      console.error('[sse] no se pudo armar el evento de', canal, causa)
    }
  }
}

let hub: Hub | null = null

export function hubSse(): Hub {
  hub ??= new Hub()
  return hub
}

/**
 * Lee la instantánea publicada por el collector y la completa.
 *
 * El collector guarda host y contenedores; los despliegues activos y las
 * alertas abiertas se agregan acá para que el navegador reciba todo el estado
 * en un solo evento y no tenga que encadenar pedidos.
 */
export async function leerInstantanea(): Promise<Instantanea | null> {
  const db = base()

  /* Ordenado por fecha: con `limit(1)` a secas, PostgreSQL devuelve una fila
   * arbitraria, y si alguna vez hubo dos hosts —o el id del host cambió— la
   * consola podía quedar mostrando la instantánea vieja de forma permanente. */
  const filas = await db
    .select({ contenido: instantaneas.contenido, actualizada: instantaneas.actualizadaEn })
    .from(instantaneas)
    .orderBy(desc(instantaneas.actualizadaEn))
    .limit(1)

  const fila = filas[0]
  if (fila === undefined) return null

  const validada = esquemaInstantanea.safeParse(fila.contenido)
  if (!validada.success) {
    // Instantánea escrita por una versión distinta del collector: mejor no
    // mostrar nada que dibujar un panel con campos faltantes.
    console.error('[sse] instantánea con forma inesperada')
    return null
  }

  const [activos, abiertas, latidos] = await Promise.all([
    desplieguesActivos(db),
    alertasAbiertas(db),
    db
      .select({ vistoEn: latidosCollector.vistoEn })
      .from(latidosCollector)
      .orderBy(desc(latidosCollector.vistoEn))
      .limit(1),
  ])

  return {
    ...validada.data,
    desplieguesActivos: activos,
    alertasAbiertas: abiertas,
    ultimoLatido: latidos[0]?.vistoEn.toISOString() ?? validada.data.ultimoLatido,
  }
}

/** Serializa un evento al formato de texto de SSE. */
export function formatearEvento(evento: EventoEmitido): string {
  return `id: ${evento.id}\nevent: ${evento.tipo}\ndata: ${JSON.stringify(evento.datos)}\n\n`
}
