import { defineMiddleware } from 'astro:middleware'
import { base } from './lib/base.js'
import {
  DURACION_SESION_MS,
  NOMBRE_COOKIE_CSRF,
  NOMBRE_COOKIE_SESION,
  validarSesion,
} from './lib/sesion.js'
import {
  CABECERA_CSRF,
  aplicarCabecerasSeguridad,
  csrfValido,
  metodoSeguro,
  opcionesCookieCsrf,
  opcionesCookieSesion,
  origenValido,
  tokenCsrf,
} from './lib/seguridad.js'
import {
  CABECERA_AUTORIZACION,
  alcancePermiteMetodo,
  secretoDeCabecera,
  validarClave,
} from './lib/clavesApi.js'
import { error } from './lib/respuestas.js'
import { asegurarVigilante } from './lib/vigilante.js'

/* ============================================================================
 * Middleware: sesión, CSRF y cabeceras.
 *
 * Corre antes que cualquier página o endpoint. Tres responsabilidades:
 *
 *  1. Resolver la sesión y dejarla en `locals`, para que ninguna ruta tenga
 *     que acordarse de validar la cookie.
 *  2. Rechazar mutaciones sin CSRF válido. La verificación es acá y no en cada
 *     endpoint justamente para que no se pueda olvidar en uno.
 *  3. Poner las cabeceras de seguridad en todas las respuestas.
 * ========================================================================== */

/**
 * Rutas accesibles sin sesión. Todo lo demás pide login.
 *
 * `/api/sesion` está acá porque es el endpoint por el que se obtiene la
 * sesión: exigirla para llegar sería un círculo. Su protección es otra —
 * verificación de `Origin` y rate limiting por IP y por cuenta.
 */
const RUTAS_PUBLICAS = new Set(['/login', '/api/salud', '/api/sesion'])

function esRutaPublica(ruta: string): boolean {
  return RUTAS_PUBLICAS.has(ruta)
}

function esApi(ruta: string): boolean {
  return ruta.startsWith('/api/')
}

export const onRequest = defineMiddleware(async (contexto, next) => {
  const { cookies, locals, request, url } = contexto

  locals.sesion = null
  locals.claveApi = null
  locals.identidad = null
  locals.csrf = ''

  // Idempotente: sólo la primera request del proceso lo arranca.
  asegurarVigilante()

  const db = base()
  const token = cookies.get(NOMBRE_COOKIE_SESION)?.value

  if (token !== undefined && token.length > 0) {
    try {
      const { sesion, tokenRotado } = await validarSesion(db, token)
      locals.sesion = sesion

      if (sesion !== null) {
        locals.csrf = tokenCsrf(sesion.id)

        if (tokenRotado !== null) {
          const maxAge = Math.floor(DURACION_SESION_MS / 1000)
          cookies.set(NOMBRE_COOKIE_SESION, tokenRotado, opcionesCookieSesion(maxAge))
          cookies.set(NOMBRE_COOKIE_CSRF, locals.csrf, opcionesCookieCsrf(maxAge))
        }
      } else {
        // Token vencido o revocado: se limpia para que el navegador deje de
        // mandarlo en cada request.
        cookies.delete(NOMBRE_COOKIE_SESION, { path: '/' })
        cookies.delete(NOMBRE_COOKIE_CSRF, { path: '/' })
      }
    } catch (causa) {
      // La base caída no puede dejar la app en un estado indefinido: se sigue
      // como visitante sin sesión y las rutas protegidas mandan al login.
      console.error('[middleware] no se pudo validar la sesión:', causa)
    }
  }

  if (locals.sesion !== null) {
    const s = locals.sesion
    locals.identidad = {
      usuarioId: s.usuarioId,
      email: s.email,
      nombre: s.nombre,
      rol: s.rol,
      via: 'sesion',
    }
  }

  /* --- Clave de API ---------------------------------------------------- */

  /* Sólo para `/api/`. Una clave no abre el dashboard: las páginas necesitan
   * una sesión de navegador, y aceptar un Bearer para renderizar HTML sólo
   * agregaría superficie sin resolver ningún caso de uso real.
   *
   * Va después de la cookie: si el pedido trae las dos cosas, gana la sesión.
   * Es lo que espera quien está probando algo desde la consola del navegador. */
  if (locals.identidad === null && esApi(url.pathname)) {
    const secreto = secretoDeCabecera(request.headers.get(CABECERA_AUTORIZACION))

    if (secreto !== null) {
      try {
        const clave = await validarClave(db, secreto)
        if (clave !== null) {
          locals.claveApi = clave
          locals.identidad = {
            usuarioId: clave.usuarioId,
            email: clave.email,
            nombre: clave.nombreUsuario,
            rol: clave.rol,
            via: 'clave',
          }
        }
      } catch (causa) {
        console.error('[middleware] no se pudo validar la clave de API:', causa)
      }
    }
  }

  /* --- CSRF ------------------------------------------------------------ */

  /* Un pedido autenticado con clave de API no lleva CSRF, y no es una
   * excepción incómoda sino la consecuencia de qué protege el CSRF: el ataque
   * es que el NAVEGADOR adjunte sola la credencial en un pedido de otro sitio.
   * Una cabecera `Authorization` no se adjunta sola en ningún caso — hay que
   * escribirla, y para escribirla hay que tener el secreto.
   *
   * Lo que sí se verifica es el alcance: una clave `read` no muta nada. */
  if (!metodoSeguro(request.method) && locals.claveApi !== null) {
    if (!alcancePermiteMetodo(locals.claveApi.alcance, request.method)) {
      return error(
        'sin_permiso',
        'Esta clave de API es de sólo lectura. Creá una con alcance «admin» para modificar.',
      )
    }
  } else if (!metodoSeguro(request.method)) {
    if (!origenValido(request, url)) {
      return error('csrf_invalido', 'El origen del pedido no coincide.')
    }

    /* El login es la excepción: todavía no hay sesión de la cual derivar un
     * token CSRF. Lo protege el chequeo de `Origin` de arriba más el rate
     * limiting.
     *
     * Se compara también el método: el DELETE de esta misma ruta es el
     * logout, y ése sí tiene sesión, así que no tiene por qué saltearse el
     * CSRF. Sin el chequeo de método, un sitio de terceros podría desloguear
     * al usuario. */
    const esLogin =
      (url.pathname === '/api/sesion' && request.method === 'POST') ||
      url.pathname === '/login'

    if (!esLogin) {
      const sesion = locals.sesion
      if (sesion === null) return error('no_autenticado')

      // Sólo vale la cabecera. Aceptar además la cookie anularía la
      // protección: el navegador manda las cookies solo en un POST
      // cross-site, pero no una cabecera propia.
      if (!csrfValido(sesion.id, request.headers.get(CABECERA_CSRF))) {
        return error('csrf_invalido')
      }
    }
  }

  /* --- Autorización ---------------------------------------------------- */

  if (locals.identidad === null && !esRutaPublica(url.pathname)) {
    if (esApi(url.pathname)) return error('no_autenticado')

    // A la página se llega con `?siguiente=` para volver adonde iba después
    // de entrar.
    const destino = new URL('/login', url)
    if (url.pathname !== '/') destino.searchParams.set('siguiente', url.pathname + url.search)
    return contexto.redirect(destino.pathname + destino.search, 302)
  }

  // Ya con sesión, /login no tiene sentido.
  if (locals.sesion !== null && url.pathname === '/login') {
    return contexto.redirect('/dashboard', 302)
  }

  const respuesta = await next()
  aplicarCabecerasSeguridad(respuesta.headers)
  return respuesta
})
