import type { APIRoute } from 'astro'
import { esquemaConsultaDespliegues } from '@vmstats/shared'
import { base } from '@/lib/base'
import { historialDespliegues } from '@/lib/despliegues'
import { error, json, protegido } from '@/lib/respuestas'

/* ============================================================================
 * Despliegues: activos, historial y timeline de transiciones.
 * ========================================================================== */

export const GET: APIRoute = async ({ url }) =>
  protegido(async () => {
    const validado = esquemaConsultaDespliegues.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    )
    if (!validado.success) return error('entrada_invalida')

    return json(await historialDespliegues(base(), validado.data.limite))
  }, 'GET /api/despliegues')
