import type { APIRoute } from 'astro'
import { esquemaPreferenciasApp, guardarPreferencias, leerPreferencias } from '@vmstats/db'
import { base } from '@/lib/base'
import { auditar } from '@/lib/auditoria'
import { logsDisponibles } from '@/lib/collector'
import { error, json, protegido } from '@/lib/respuestas'

/* ============================================================================
 * Preferencias de la instancia.
 * ========================================================================== */

export const GET: APIRoute = async () =>
  protegido(async () => {
    const preferencias = await leerPreferencias(base())
    return json({
      ...preferencias,
      // La UI necesita distinguir «los logs están apagados por preferencia» de
      // «esta instancia no tiene la API interna configurada»: en el segundo
      // caso, encender la preferencia no alcanza.
      apiInternaConfigurada: logsDisponibles(),
    })
  }, 'GET /api/preferencias')

export const PATCH: APIRoute = async ({ request, locals }) =>
  protegido(async () => {
    const quienPide = locals.identidad
    if (quienPide === null) return error('no_autenticado')

    let cuerpo: unknown
    try {
      cuerpo = await request.json()
    } catch {
      return error('entrada_invalida')
    }

    const validado = esquemaPreferenciasApp.partial().safeParse(cuerpo)
    if (!validado.success) {
      return error('entrada_invalida', validado.error.issues[0]?.message)
    }

    // Zona horaria inválida: `Intl` es la única fuente confiable de qué zonas
    // existen, y una zona rota rompería todas las fechas de la consola.
    const zona = validado.data.zonaHoraria
    if (zona !== undefined && !zonaValida(zona)) {
      return error('entrada_invalida', 'Esa zona horaria no existe.')
    }

    const db = base()
    const nuevas = await guardarPreferencias(db, validado.data)

    await auditar(db, {
      usuarioId: quienPide.usuarioId,
      usuarioEmail: quienPide.email,
      accion: 'preferencias.editar',
      detalle: validado.data,
    })

    return json(nuevas)
  }, 'PATCH /api/preferencias')

function zonaValida(zona: string): boolean {
  try {
    // `Intl` es la única fuente confiable de qué zonas existen: construir el
    // formateador tira RangeError si la zona no es válida.
    const formateador = new Intl.DateTimeFormat('es-AR', { timeZone: zona })
    return formateador.resolvedOptions().timeZone.length > 0
  } catch {
    return false
  }
}
