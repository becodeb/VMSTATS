import type { APIRoute } from 'astro'
import { esquemaConsultaHistorial, rangoDesdeClave } from '@vmstats/shared'
import { leerPreferencias } from '@vmstats/db'
import { base } from '@/lib/base'
import { consultarHistorial, historialACsv } from '@/lib/historial'
import { error, protegido } from '@/lib/respuestas'

/* ============================================================================
 * Exportación CSV.
 *
 * Limitada al rango consultado, como pide la spec: no hay un «exportar todo»
 * que se traiga un año de muestras a 10 segundos. El CSV sale de la misma
 * consulta que alimenta el gráfico, así que lo que se descarga es exactamente
 * lo que se está viendo — misma resolución, mismos buckets.
 * ========================================================================== */

export const GET: APIRoute = async ({ url }) =>
  protegido(async () => {
    const crudo = Object.fromEntries(url.searchParams.entries())
    const validado = esquemaConsultaHistorial.safeParse(crudo)

    if (!validado.success) {
      return error('entrada_invalida', validado.error.issues[0]?.message)
    }

    const consulta = validado.data
    const { desde, hasta } =
      consulta.rango !== undefined
        ? rangoDesdeClave(consulta.rango)
        : { desde: new Date(consulta.desde ?? ''), hasta: new Date(consulta.hasta ?? '') }

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      return error('entrada_invalida', 'Las fechas no son válidas.')
    }

    const db = base()
    const preferencias = await leerPreferencias(db)
    const respuesta = await consultarHistorial(db, {
      desde,
      hasta,
      series: consulta.series,
      hostId: consulta.hostId,
      preferencias,
    })

    const nombre = `vmstats-${desde.toISOString().slice(0, 10)}-a-${hasta
      .toISOString()
      .slice(0, 10)}.csv`

    // El BOM hace que Excel abra el archivo como UTF-8; sin él rompe los
    // acentos de las etiquetas de las series.
    const BOM = String.fromCharCode(0xfeff)

    return new Response(BOM + historialACsv(respuesta), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${nombre}"`,
        'Cache-Control': 'no-store',
      },
    })
  }, 'GET /api/exportar')
