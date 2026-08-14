import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { LogsContenedor } from '@vmstats/shared'

/* ============================================================================
 * API interna del collector.
 *
 * Existe por una sola razón: los logs de contenedor se piden bajo demanda desde
 * la UI, y el proceso web no puede tener acceso al Docker socket — ni directo
 * ni a través del proxy. El collector, que sí lo tiene, expone este único
 * endpoint de lectura para que web se los pida.
 *
 * Controles, en capas:
 *
 *  - El puerto NO se publica al host en el compose. Sólo existe dentro de la
 *    red interna de Docker; desde afuera de la VM no es alcanzable.
 *  - Hace falta un bearer token compartido por variable de entorno. Sin él, el
 *    servidor ni siquiera arranca.
 *  - Sólo hay un método y una ruta. No existe forma de pedir otra cosa.
 *  - Los logs salen ya redactados por el collector, no en crudo.
 *
 * Ver docs/security.md.
 * ========================================================================== */

export interface OpcionesServidorInterno {
  puerto: number
  /** Token compartido con el proceso web. Mínimo 32 caracteres. */
  token: string
  /** Trae los logs ya redactados de un contenedor. */
  traerLogs: (contenedorId: string, lineas: number) => Promise<LogsContenedor>
  /** Si los logs están habilitados en las preferencias. */
  logsHabilitados: () => Promise<boolean>
}

function comparar(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function responder(res: ServerResponse, estado: number, cuerpo: unknown): void {
  const texto = JSON.stringify(cuerpo)
  res.writeHead(estado, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  })
  res.end(texto)
}

/** `/logs/<id>?lineas=N`. El id de contenedor es hexadecimal, nada más. */
const RUTA_LOGS = /^\/logs\/([0-9a-f]{12,64})$/

export function crearServidorInterno(opciones: OpcionesServidorInterno): Server {
  if (opciones.token.length < 32) {
    throw new Error('COLLECTOR_TOKEN_INTERNO tiene que tener al menos 32 caracteres')
  }

  const manejar = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      responder(res, 405, { error: 'metodo_no_permitido' })
      return
    }

    const autorizacion = req.headers.authorization ?? ''
    const recibido = autorizacion.startsWith('Bearer ') ? autorizacion.slice(7) : ''
    if (!comparar(opciones.token, recibido)) {
      responder(res, 401, { error: 'no_autorizado' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://interno')

    if (url.pathname === '/salud') {
      responder(res, 200, { estado: 'ok' })
      return
    }

    const coincidencia = RUTA_LOGS.exec(url.pathname)
    if (coincidencia === null) {
      responder(res, 404, { error: 'no_encontrado' })
      return
    }

    if (!(await opciones.logsHabilitados())) {
      responder(res, 403, { error: 'logs_deshabilitados' })
      return
    }

    const contenedorId = coincidencia[1]
    if (contenedorId === undefined) {
      responder(res, 400, { error: 'id_invalido' })
      return
    }

    const pedidas = Number.parseInt(url.searchParams.get('lineas') ?? '200', 10)
    const lineas = Number.isFinite(pedidas) ? Math.min(1000, Math.max(10, pedidas)) : 200

    try {
      responder(res, 200, await opciones.traerLogs(contenedorId, lineas))
    } catch (causa) {
      console.error('[interno] no se pudieron traer los logs:', causa)
      // El mensaje de Docker puede llevar rutas del host: no se propaga.
      responder(res, 502, { error: 'docker_no_responde' })
    }
  }

  const servidor = createServer((req, res) => {
    void manejar(req, res).catch(() => {
      responder(res, 500, { error: 'error_interno' })
    })
  })

  // Un cliente que abre y no manda nada no puede ocupar un socket para siempre.
  servidor.headersTimeout = 5_000
  servidor.requestTimeout = 30_000

  servidor.listen(opciones.puerto, '0.0.0.0')
  return servidor
}
