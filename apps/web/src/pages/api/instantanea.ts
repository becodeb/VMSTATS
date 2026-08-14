import type { APIRoute } from 'astro'
import { error, json, protegido } from '@/lib/respuestas'
import { leerInstantanea } from '@/lib/sse'

/* ============================================================================
 * Estado actual, en un solo pedido.
 *
 * Es el fallback del SSE: cuando el stream no logra establecerse —un proxy
 * corporativo que corta `text/event-stream`, por ejemplo— el cliente pasa a
 * consultar esto cada 15 segundos. Devuelve exactamente el mismo payload que
 * el evento `instantanea`, así que el resto de la UI no se entera de cuál de
 * los dos caminos está activo.
 * ========================================================================== */

export const GET: APIRoute = async () =>
  protegido(async () => {
    const foto = await leerInstantanea()
    // Sin instantánea, el collector todavía no completó su primer ciclo. Es un
    // estado legítimo del arranque, no un error.
    if (foto === null) return error('no_disponible', 'El collector todavía no reportó.')
    return json(foto)
  }, 'GET /api/instantanea')
