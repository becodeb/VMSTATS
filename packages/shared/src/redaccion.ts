/* ============================================================================
 * Redacción de secretos en logs de contenedor.
 *
 * Los logs se piden bajo demanda y se muestran en el inspector. Un log de
 * arranque cualquiera imprime `DATABASE_URL=postgres://user:pass@host` sin
 * pensarlo dos veces, así que todo pasa por acá antes de llegar al navegador.
 *
 * El criterio es pecar de prudente: preferimos tapar de más que filtrar una
 * credencial. Lo que se tapa se cuenta y se informa en la UI.
 * ========================================================================== */

export const MARCA_REDACTADO = '[redactado]'

interface Patron {
  nombre: string
  expresion: RegExp
  /** Qué grupo de captura reemplazar; 0 = la coincidencia entera. */
  grupo: number
}

/**
 * El orden importa: los patrones más específicos van primero, porque cada uno
 * se aplica sobre el resultado del anterior.
 */
const PATRONES: readonly Patron[] = [
  // Authorization: Bearer xxx / Basic xxx
  {
    nombre: 'header-authorization',
    expresion: /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*([\w\-._~+/=]{8,})/gi,
    grupo: 2,
  },
  // Credenciales embebidas en una URL: proto://user:secreto@host
  {
    nombre: 'url-credenciales',
    expresion: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(?=@)/gi,
    grupo: 2,
  },
  /* clave=valor donde la clave huele a secreto. Cubre password, passwd, pwd,
   * secret, token, api_key, apikey, access_key, private_key, credential.
   *
   * El valor se tapa sea del largo que sea. Un mínimo de caracteres dejaba
   * pasar contraseñas cortas, y como el filtro ya exige que la CLAVE sea
   * sensible, no hay riesgo de tapar de más: `LOG_LEVEL=info` no coincide. */
  {
    nombre: 'clave-valor-sensible',
    expresion:
      /\b((?:[\w.-]*(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[\w.-]*)\s*[:=]\s*)(?:"([^"]+)"|'([^']+)'|([^\s,;"']+))/gi,
    grupo: 0,
  },
  // JWT: tres segmentos base64url separados por puntos.
  {
    nombre: 'jwt',
    expresion: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g,
    grupo: 0,
  },
  // Claves de proveedores con prefijo reconocible (sk-, ghp_, xoxb-, AKIA…).
  {
    nombre: 'token-con-prefijo',
    expresion: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b/g,
    grupo: 0,
  },
  // Bloques PEM en una línea.
  {
    nombre: 'pem',
    expresion: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
    grupo: 0,
  },
]

export interface ResultadoRedaccion {
  texto: string
  redacciones: number
}

/**
 * Tapa los secretos de un texto y devuelve cuántos tapó.
 *
 * Para `clave-valor-sensible` conservamos el nombre de la clave y reemplazamos
 * sólo el valor: saber que existe `DATABASE_PASSWORD` es útil para operar, y
 * el valor es lo único que hay que esconder.
 */
export function redactar(texto: string): ResultadoRedaccion {
  let resultado = texto
  let redacciones = 0

  for (const patron of PATRONES) {
    resultado = resultado.replace(patron.expresion, (coincidencia, ...grupos: unknown[]) => {
      redacciones += 1
      if (patron.grupo === 0) {
        // Si el patrón captura un prefijo (clave=), lo conservamos.
        const prefijo = grupos[0]
        if (typeof prefijo === 'string' && /[:=]\s*$/.test(prefijo)) {
          return `${prefijo}${MARCA_REDACTADO}`
        }
        return MARCA_REDACTADO
      }
      const objetivo = grupos[patron.grupo - 1]
      if (typeof objetivo !== 'string') {
        return MARCA_REDACTADO
      }
      const indice = coincidencia.lastIndexOf(objetivo)
      if (indice < 0) return MARCA_REDACTADO
      return coincidencia.slice(0, indice) + MARCA_REDACTADO
    })
  }

  return { texto: resultado, redacciones }
}

/** Igual que `redactar` pero sobre una lista, acumulando el conteo. */
export function redactarLineas(lineas: readonly string[]): {
  lineas: string[]
  redacciones: number
} {
  let total = 0
  const salida = lineas.map((linea) => {
    const r = redactar(linea)
    total += r.redacciones
    return r.texto
  })
  return { lineas: salida, redacciones: total }
}
