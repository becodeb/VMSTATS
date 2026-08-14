import type { ErrorApi } from '@vmstats/shared'

/* ============================================================================
 * Respuestas HTTP de la API.
 *
 * Todos los errores salen por acá. La regla es que el cliente recibe un código
 * estable y una frase para humanos, nunca el mensaje de la excepción: un error
 * de Postgres puede llevar nombres de tablas, y uno de Coolify puede llevar
 * parte del token. El detalle va al log del servidor.
 * ========================================================================== */

const SIN_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const

export function json(datos: unknown, estado = 200, cabeceras: HeadersInit = {}): Response {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SIN_CACHE, ...cabeceras },
  })
}

const ESTADOS: Record<ErrorApi['codigo'], number> = {
  no_autenticado: 401,
  sin_permiso: 403,
  csrf_invalido: 403,
  entrada_invalida: 400,
  no_encontrado: 404,
  demasiados_intentos: 429,
  dependencia_caida: 502,
  no_disponible: 503,
  error_interno: 500,
}

const MENSAJES: Record<ErrorApi['codigo'], string> = {
  no_autenticado: 'Necesitás iniciar sesión.',
  sin_permiso: 'No tenés permiso para esta operación.',
  csrf_invalido: 'La sesión expiró o el pedido no es válido. Recargá la página.',
  entrada_invalida: 'Los datos enviados no son válidos.',
  no_encontrado: 'No se encontró lo que buscabas.',
  demasiados_intentos: 'Demasiados intentos. Probá de nuevo en unos minutos.',
  dependencia_caida: 'Un servicio del que dependemos no está respondiendo.',
  no_disponible: 'Esta información no está disponible en este host.',
  error_interno: 'Algo falló de nuestro lado.',
}

export function error(
  codigo: ErrorApi['codigo'],
  mensaje?: string,
  cabeceras: HeadersInit = {},
): Response {
  const cuerpo: ErrorApi = { codigo, mensaje: mensaje ?? MENSAJES[codigo] }
  return json(cuerpo, ESTADOS[codigo], cabeceras)
}

/**
 * Envuelve un handler y convierte cualquier excepción en un 500 genérico.
 *
 * Es la red de contención: sin esto, una excepción no prevista de Drizzle
 * llegaría al cliente con el SQL adentro.
 */
export function protegido(
  handler: () => Promise<Response>,
  contexto: string,
): Promise<Response> {
  return handler().catch((causa: unknown) => {
    console.error(`[api] ${contexto}:`, causa)
    return error('error_interno')
  })
}
