import { esquemaLogsContenedor, type LogsContenedor } from '@vmstats/shared'

/* ============================================================================
 * Cliente de la API interna del collector.
 *
 * Sirve para una sola cosa: pedir los logs de un contenedor. El proceso web no
 * tiene —ni puede tener— acceso al Docker socket, así que se los pide al
 * collector, que ya los devuelve redactados.
 *
 * La URL apunta al nombre de servicio de Docker Compose (`collector`), que sólo
 * resuelve dentro de la red interna.
 * ========================================================================== */

export type ResultadoLogs =
  | { ok: true; logs: LogsContenedor }
  | { ok: false; motivo: 'apagado' | 'deshabilitado' | 'sin_collector' | 'error' }

interface ConfiguracionCollector {
  url: string
  token: string
}

function configuracion(): ConfiguracionCollector | null {
  const url = process.env['COLLECTOR_URL_INTERNA'] ?? ''
  const token = process.env['COLLECTOR_TOKEN_INTERNO'] ?? ''
  // Sin cualquiera de los dos, la función queda apagada. No hay valor por
  // defecto: un token por omisión sería una credencial por defecto.
  if (url.length === 0 || token.length < 32) return null
  return { url: url.replace(/\/+$/, ''), token }
}

/** Si la instancia tiene la API interna configurada. */
export function logsDisponibles(): boolean {
  return configuracion() !== null
}

export async function traerLogsDeContenedor(
  contenedorId: string,
  lineas: number,
): Promise<ResultadoLogs> {
  const config = configuracion()
  if (config === null) return { ok: false, motivo: 'apagado' }

  const control = new AbortController()
  const temporizador = setTimeout(() => control.abort(), 15_000)

  try {
    const respuesta = await fetch(
      `${config.url}/logs/${encodeURIComponent(contenedorId)}?lineas=${lineas}`,
      {
        headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
        signal: control.signal,
      },
    )

    if (respuesta.status === 403) return { ok: false, motivo: 'deshabilitado' }
    if (!respuesta.ok) return { ok: false, motivo: 'error' }

    const validado = esquemaLogsContenedor.safeParse(await respuesta.json())
    if (!validado.success) return { ok: false, motivo: 'error' }

    return { ok: true, logs: validado.data }
  } catch {
    // El collector caído no es un error del usuario: la UI lo muestra como
    // «no disponible» con el motivo.
    return { ok: false, motivo: 'sin_collector' }
  } finally {
    clearTimeout(temporizador)
  }
}
