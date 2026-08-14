import type { APIRoute } from 'astro'
import { INTERVALO_LATIDO_MS } from '@vmstats/shared'
import { formatearEvento, hubSse, leerInstantanea } from '@/lib/sse'
import { error } from '@/lib/respuestas'

/* ============================================================================
 * Flujo SSE.
 *
 * Cada navegador conectado abre un stream contra este endpoint. Los eventos no
 * se generan acá: los produce el hub, que escucha una sola conexión LISTEN
 * contra Postgres y abanica. Con veinte pestañas abiertas sigue habiendo una
 * sola conexión escuchando la base.
 *
 * Reanudación: el cliente manda `?desde=<id>` con el último evento que recibió
 * y se le entrega lo que se perdió antes de engancharlo al vivo. No se usa la
 * cabecera `Last-Event-ID` porque `EventSource` no permite mandar cabeceras
 * propias; el query param es la única vía desde el navegador.
 * ========================================================================== */

export const GET: APIRoute = async ({ url, request }) => {
  const hub = hubSse()

  const parametro = url.searchParams.get('desde')
  const desde = parametro === null ? 0 : Number.parseInt(parametro, 10)
  const ultimoRecibido = Number.isFinite(desde) && desde > 0 ? desde : 0

  const codificador = new TextEncoder()
  let desuscribir: (() => void) | null = null
  let latido: ReturnType<typeof setInterval> | null = null

  const flujo = new ReadableStream<Uint8Array>({
    async start(controlador) {
      let cerrado = false

      const escribir = (texto: string): void => {
        if (cerrado) return
        try {
          controlador.enqueue(codificador.encode(texto))
        } catch {
          // El cliente cerró la pestaña entre el evento y el enqueue.
          cerrado = true
        }
      }

      // `retry` le dice al navegador cuánto esperar si es él quien reconecta.
      escribir(`retry: 5000\n\n`)

      try {
        desuscribir = await hub.suscribir((evento) => escribir(formatearEvento(evento)))
      } catch (causa) {
        console.error('[flujo] no se pudo suscribir al hub:', causa)
        escribir(': el bus de eventos no está disponible\n\n')
        controlador.close()
        return
      }

      /* Estado inicial y reanudación.
       *
       * Con `desde`, primero van los eventos perdidos; sin él (o si se
       * perdieron más de los que guarda el historial), va una instantánea
       * completa. En los dos casos el cliente termina con estado consistente
       * sin tener que hacer un pedido aparte. */
      const perdidos = ultimoRecibido > 0 ? hub.desde(ultimoRecibido) : []

      if (perdidos.length > 0) {
        for (const evento of perdidos) escribir(formatearEvento(evento))
      } else {
        const foto = await leerInstantanea()
        if (foto !== null) {
          escribir(
            formatearEvento({ id: hub.ultimoId, tipo: 'instantanea', datos: foto }),
          )
        }
      }

      /* Latido cada 20 s.
       *
       * Dos funciones: mantiene viva la conexión a través de proxies que cortan
       * por inactividad (Coolify tiene uno adelante), y le da al cliente una
       * señal de vida independiente de que lleguen datos. */
      latido = setInterval(() => {
        /* El id va con el último real, no con 0.
         *
         * El navegador guarda el `id:` de cada evento como `Last-Event-ID`;
         * mandar 0 en cada latido borraba la marca de reanudación cada 20
         * segundos. */
        escribir(
          formatearEvento({
            id: hub.ultimoId,
            tipo: 'latido',
            datos: { ts: new Date().toISOString(), ultimoId: hub.ultimoId },
          }),
        )
      }, INTERVALO_LATIDO_MS)

      const cerrar = (): void => {
        if (cerrado) return
        cerrado = true
        if (latido !== null) clearInterval(latido)
        desuscribir?.()
        try {
          controlador.close()
        } catch {
          // Ya estaba cerrado.
        }
      }

      // Sin esto, cada pestaña cerrada deja un intervalo y una suscripción
      // vivos para siempre en un proceso que corre durante meses.
      request.signal.addEventListener('abort', cerrar)
    },

    cancel() {
      if (latido !== null) clearInterval(latido)
      desuscribir?.()
    },
  })

  return new Response(flujo, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx bufferea por defecto y eso rompe SSE: los eventos llegarían en
      // tandas de 4 kB en vez de al instante.
      'X-Accel-Buffering': 'no',
    },
  })
}

/** Cualquier otro método sobre el flujo es un error de uso. */
export const POST: APIRoute = () => error('no_encontrado')
