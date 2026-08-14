import type { APIRoute } from 'astro'
import { sql } from 'drizzle-orm'
import { base } from '@/lib/base'

/* ============================================================================
 * Healthcheck del contenedor web.
 *
 * Es la única ruta que no pide sesión: Docker la consulta sin credenciales.
 * Por eso no devuelve nada que sirva a alguien de afuera — ni versión, ni
 * hostname, ni el estado del collector. Sólo si esta instancia puede atender.
 *
 * Comprueba la base a propósito: un proceso web que responde pero no puede
 * leer Postgres no sirve para nada, y marcarlo sano haría que el balanceador
 * le siga mandando tráfico.
 * ========================================================================== */

export const GET: APIRoute = async () => {
  try {
    await base().execute(sql`SELECT 1`)
    return new Response(JSON.stringify({ estado: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch {
    return new Response(JSON.stringify({ estado: 'sin-base' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
}
