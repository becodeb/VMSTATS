import type { APIRoute } from 'astro'
import { esquemaConsultaLogs } from '@vmstats/shared'
import { leerPreferencias } from '@vmstats/db'
import { base } from '@/lib/base'
import { traerLogsDeContenedor } from '@/lib/collector'
import { error, json, protegido } from '@/lib/respuestas'

/* ============================================================================
 * Logs de un contenedor, bajo demanda.
 *
 * Doble compuerta antes de llegar a Docker:
 *
 *  1. La preferencia `logsHabilitados`, apagada por defecto. La spec pide que
 *     las funciones que puedan requerir un token de Coolify con
 *     `read:sensitive` no vengan encendidas.
 *  2. La API interna del collector, que exige el token compartido.
 *
 * Este proceso nunca habla con Docker. Los logs llegan ya redactados.
 * ========================================================================== */

/** Id de contenedor de Docker: hexadecimal, 12 a 64 caracteres. */
const ID_VALIDO = /^[0-9a-f]{12,64}$/

export const GET: APIRoute = async ({ params, url }) =>
  protegido(async () => {
    const id = params['id'] ?? ''
    if (!ID_VALIDO.test(id)) {
      return error('entrada_invalida', 'El identificador de contenedor no es válido.')
    }

    const validado = esquemaConsultaLogs.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    )
    if (!validado.success) return error('entrada_invalida')

    const preferencias = await leerPreferencias(base())
    if (!preferencias.logsHabilitados) {
      return error(
        'no_disponible',
        'Los logs están deshabilitados. Se activan en Preferencias.',
      )
    }

    const resultado = await traerLogsDeContenedor(
      id,
      Math.min(validado.data.lineas, preferencias.logsMaxLineas),
    )

    if (!resultado.ok) {
      if (resultado.motivo === 'deshabilitado') {
        return error('no_disponible', 'Los logs están deshabilitados en el collector.')
      }
      if (resultado.motivo === 'apagado') {
        return error(
          'no_disponible',
          'La API interna del collector no está configurada en esta instancia.',
        )
      }
      if (resultado.motivo === 'sin_collector') {
        return error('dependencia_caida', 'El collector no está respondiendo.')
      }
      return error('dependencia_caida', 'No se pudieron leer los logs.')
    }

    return json(resultado.logs)
  }, 'GET /api/contenedores/[id]/logs')
