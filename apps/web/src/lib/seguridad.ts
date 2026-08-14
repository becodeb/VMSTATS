import { createHmac } from 'node:crypto'
import { entorno, esProduccion } from './entorno.js'
import { igualdadSegura } from './sesion.js'

/* ============================================================================
 * CSRF y cabeceras de seguridad.
 * ========================================================================== */

export const CABECERA_CSRF = 'x-vmstats-csrf'

/**
 * Token CSRF derivado del id de sesión.
 *
 * Es un double-submit *firmado*: en vez de comparar la cookie contra la
 * cabecera y confiar en que nadie más pueda escribir cookies, el token es un
 * HMAC del id de sesión con el secreto del servidor. Aunque alguien logre
 * plantar una cookie desde un subdominio, no puede fabricar un token válido
 * sin el secreto — y como el HMAC va atado a la sesión, un token de otra
 * sesión tampoco sirve.
 */
export function tokenCsrf(idSesion: string): string {
  return createHmac('sha256', entorno().SESSION_SECRET)
    .update(`csrf:${idSesion}`)
    .digest('base64url')
}

export function csrfValido(idSesion: string, recibido: string | null): boolean {
  if (recibido === null || recibido.length === 0) return false
  return igualdadSegura(tokenCsrf(idSesion), recibido)
}

/**
 * ¿El pedido viene de nuestro propio origen?
 *
 * Segunda barrera, independiente del token. Un navegador moderno siempre manda
 * `Origin` en las peticiones que mutan estado, así que su ausencia en un POST
 * ya es sospechosa.
 */
export function origenValido(peticion: Request, urlDelSitio: URL): boolean {
  const origen = peticion.headers.get('origin')
  if (origen === null) {
    // Sin Origin sólo se acepta si tampoco hay Referer de otro sitio: cubre a
    // clientes no-navegador que peguen contra la API con un token válido.
    const referer = peticion.headers.get('referer')
    if (referer === null) return true
    try {
      return new URL(referer).origin === urlDelSitio.origin
    } catch {
      return false
    }
  }

  const configurado = entorno().PUBLIC_ORIGIN
  if (configurado.length > 0) return origen === configurado
  return origen === urlDelSitio.origin
}

/** Métodos que no mutan estado y por lo tanto no piden CSRF. */
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function metodoSeguro(metodo: string): boolean {
  return METODOS_SEGUROS.has(metodo.toUpperCase())
}

/* -------------------------------------------------------------------------
 * Cabeceras
 * ---------------------------------------------------------------------- */

/**
 * La parte del CSP que va por cabecera.
 *
 * El grueso de la política la emite Astro en un `<meta>` (ver
 * `astro.config.mjs`), porque es lo único que conoce el hash de los scripts
 * inline con los que hidrata las islas de React. Una política escrita a mano
 * acá los bloquearía y la consola cargaría como HTML muerto — probado: sin
 * esto, ni un botón responde.
 *
 * Quedan las directivas que un `<meta>` no puede aplicar: `frame-ancestors`
 * es ignorada por especificación cuando viene en un meta, y sólo cuenta como
 * cabecera. `upgrade-insecure-requests` se manda junto porque en producción
 * conviene tenerla en las dos formas.
 */
export function politicaCsp(): string {
  const directivas = [
    "frame-ancestors 'none'",

    /* Atributos `style` inline.
     *
     * Hace falta una directiva propia porque `'unsafe-inline'` dentro de
     * `style-src` queda ANULADO en cuanto hay un hash en la lista, y Astro
     * agrega hashes para sus propios `<style>`. Sin esto, el navegador
     * bloqueaba en silencio todos los `style={{…}}` de React: la pastilla de
     * la navegación no se movía, las barras de uso quedaban en cero y la línea
     * de pulso no se dibujaba. Sólo lo detectó el test en navegador.
     *
     * `style-src-attr` gobierna únicamente los atributos, así que los `<style>`
     * siguen protegidos por hash. Un atributo de estilo no puede cargar
     * recursos ni ejecutar código: el riesgo que abre es cosmético.
     *
     * Va acá y no en `astro.config.mjs` porque Astro no admite esta directiva
     * en su lista. */
    "style-src-attr 'unsafe-inline'",
  ]
  if (esProduccion()) directivas.push('upgrade-insecure-requests')
  return directivas.join('; ')
}

/**
 * Combina nuestras directivas con las que ya puso Astro.
 *
 * Astro manda su política —la que lleva los hashes de los scripts de
 * hidratación— como cabecera en las rutas renderizadas a demanda.
 * Sobrescribirla con `set()` la borraba y dejaba la página sin ninguna
 * restricción sobre `script-src`, que es justo la que importa. Se concatena en
 * lugar de reemplazar.
 */
function combinarCsp(cabeceras: Headers): void {
  const propias = politicaCsp()
  const deAstro = cabeceras.get('Content-Security-Policy')

  if (deAstro === null || deAstro.length === 0) {
    cabeceras.set('Content-Security-Policy', propias)
    return
  }

  // Si Astro ya declaró alguna de las nuestras, no se duplica.
  const yaTiene = (directiva: string): boolean =>
    deAstro.split(';').some((d) => d.trim().startsWith(directiva))

  const faltantes = propias
    .split('; ')
    .filter((d) => !yaTiene(d.split(' ')[0] ?? d))

  if (faltantes.length === 0) return
  cabeceras.set('Content-Security-Policy', `${deAstro.replace(/;\s*$/, '')}; ${faltantes.join('; ')}`)
}

export function aplicarCabecerasSeguridad(cabeceras: Headers): void {
  combinarCsp(cabeceras)
  cabeceras.set('X-Content-Type-Options', 'nosniff')
  cabeceras.set('Referrer-Policy', 'same-origin')
  cabeceras.set('X-Frame-Options', 'DENY')
  // Esta consola no necesita ninguna de estas capacidades del navegador.
  cabeceras.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  )
  if (esProduccion()) {
    cabeceras.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

/* -------------------------------------------------------------------------
 * Cookies
 * ---------------------------------------------------------------------- */

export interface OpcionesCookie {
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict'
  path: string
  maxAge: number
}

/**
 * `SameSite=Lax` y no `Strict` a propósito: con `Strict` el usuario que llega
 * desde un link externo (una notificación, un bookmark compartido) aparece
 * deslogueado aunque tenga sesión. `Lax` no manda la cookie en peticiones
 * cruzadas que muten, que es la protección que importa.
 */
export function opcionesCookieSesion(maxAgeSegundos: number): OpcionesCookie {
  return {
    httpOnly: true,
    secure: esProduccion(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSegundos,
  }
}

/** La cookie CSRF la lee el JavaScript del cliente: no puede ser HttpOnly. */
export function opcionesCookieCsrf(maxAgeSegundos: number): OpcionesCookie {
  return {
    httpOnly: false,
    secure: esProduccion(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSegundos,
  }
}
