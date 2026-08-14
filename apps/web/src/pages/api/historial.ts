import type { APIRoute } from 'astro'
import { esquemaConsultaHistorial, rangoDesdeClave } from '@vmstats/shared'
import { leerPreferencias } from '@vmstats/db'
import { base } from '@/lib/base'
import { consultarHistorial } from '@/lib/historial'
import { eventosEnRango } from '@/lib/despliegues'
import { error, json, protegido } from '@/lib/respuestas'

/* ============================================================================
 * Series históricas.
 *
 * El cliente pide un rango y una lista de series; la resolución la elige el
 * servidor. Ver `lib/historial.ts` para el porqué.
 * ========================================================================== */

/** Techo de rango consultable: 400 días, por encima de la retención máxima. */
const RANGO_MAXIMO_MS = 400 * 24 * 60 * 60 * 1000

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
        : {
            desde: new Date(consulta.desde ?? ''),
            hasta: new Date(consulta.hasta ?? ''),
          }

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      return error('entrada_invalida', 'Las fechas no son válidas.')
    }
    if (hasta.getTime() <= desde.getTime()) {
      return error('entrada_invalida', 'El fin del rango tiene que ser posterior al inicio.')
    }
    if (hasta.getTime() - desde.getTime() > RANGO_MAXIMO_MS) {
      return error('entrada_invalida', 'El rango es demasiado largo.')
    }

    const db = base()
    const preferencias = await leerPreferencias(db)

    const [respuesta, eventos] = await Promise.all([
      consultarHistorial(db, {
        desde,
        hasta,
        series: consulta.series,
        hostId: consulta.hostId,
        preferencias,
      }),
      // Los despliegues se superponen a los gráficos: ver el pico de CPU al
      // lado del deploy que lo causó es la mitad del valor de esta vista.
      eventosEnRango(db, desde, hasta),
    ])

    return json({ ...respuesta, eventos })
  }, 'GET /api/historial')
