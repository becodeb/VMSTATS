import type { APIRoute } from 'astro'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { usuarios } from '@vmstats/db'
import { base } from '@/lib/base'
import { auditar } from '@/lib/auditoria'
import { error, json, protegido } from '@/lib/respuestas'
import {
  DURACION_SESION_MS,
  NOMBRE_COOKIE_CSRF,
  NOMBRE_COOKIE_SESION,
  cerrarSesion,
  claveEmail,
  claveIp,
  comprobarLimite,
  crearSesion,
  hashDeDescarte,
  idDeToken,
  limpiarIntentos,
  registrarIntento,
  verificarContrasenia,
} from '@/lib/sesion'
import { opcionesCookieCsrf, opcionesCookieSesion, tokenCsrf } from '@/lib/seguridad'

/* ============================================================================
 * Inicio y cierre de sesión.
 * ========================================================================== */

const esquemaLogin = z.object({
  email: z.email('Ingresá un email válido').max(254),
  contrasenia: z.string().min(1, 'Ingresá tu contraseña').max(1024),
})

/**
 * IP del cliente.
 *
 * Detrás del proxy de Coolify, `X-Forwarded-For` trae la cadena completa; el
 * primer elemento es el cliente original. Se usa sólo para rate limiting y
 * auditoría, nunca para autorizar, así que que sea falsificable no abre un
 * agujero — como mucho, alguien esquiva su propio límite por IP y choca igual
 * contra el límite por cuenta.
 */
function ipDelCliente(request: Request, directa: string | undefined): string {
  const reenviada = request.headers.get('x-forwarded-for')
  const primera = reenviada?.split(',')[0]?.trim()
  if (primera !== undefined && primera.length > 0) return primera
  return request.headers.get('x-real-ip') ?? directa ?? 'desconocida'
}

export const POST: APIRoute = async ({ request, cookies, clientAddress }) =>
  protegido(async () => {
    const db = base()
    const ip = ipDelCliente(request, clientAddress)

    let cuerpo: unknown
    try {
      cuerpo = await request.json()
    } catch {
      return error('entrada_invalida')
    }

    const validado = esquemaLogin.safeParse(cuerpo)
    if (!validado.success) {
      return error('entrada_invalida', validado.error.issues[0]?.message)
    }

    const { email, contrasenia } = validado.data

    const limite = await comprobarLimite(db, ip, email)
    if (limite.bloqueado) {
      await auditar(db, { accion: 'login.bloqueado', usuarioEmail: email, ip })
      return error('demasiados_intentos', undefined, {
        'Retry-After': String(limite.esperaSegundos),
      })
    }

    const filas = await db
      .select({
        id: usuarios.id,
        email: usuarios.email,
        hash: usuarios.hashContrasenia,
        deshabilitadoEn: usuarios.deshabilitadoEn,
      })
      .from(usuarios)
      .where(sql`lower(${usuarios.email}) = lower(${email})`)
      .limit(1)

    const usuario = filas[0]

    /* Se verifica la contraseña incluso cuando el usuario no existe.
     *
     * Sin esto, un usuario inexistente responde en 1 ms y uno existente en 50,
     * y esa diferencia permite enumerar cuentas válidas. El hash de descarte
     * es un Argon2id real, con el mismo costo. */
    const hashParaComparar = usuario?.hash ?? (await hashDeDescarte())

    const correcta = await verificarContrasenia(hashParaComparar, contrasenia)
    const valido = usuario !== undefined && usuario.deshabilitadoEn === null && correcta

    if (!valido) {
      await Promise.all([
        registrarIntento(db, claveIp(ip), false),
        registrarIntento(db, claveEmail(email), false),
        auditar(db, { accion: 'login.fallo', usuarioEmail: email, ip }),
      ])
      // Un solo mensaje para «no existe», «contraseña incorrecta» y «cuenta
      // deshabilitada»: distinguirlos le confirma a un atacante qué emails son
      // cuentas reales.
      return error('entrada_invalida', 'Email o contraseña incorrectos.')
    }

    const { token, expiraEn } = await crearSesion(
      db,
      usuario.id,
      ip,
      request.headers.get('user-agent'),
    )

    const maxAge = Math.floor(DURACION_SESION_MS / 1000)
    cookies.set(NOMBRE_COOKIE_SESION, token, opcionesCookieSesion(maxAge))
    cookies.set(
      NOMBRE_COOKIE_CSRF,
      tokenCsrf(idDeToken(token)),
      opcionesCookieCsrf(maxAge),
    )

    await Promise.all([
      limpiarIntentos(db, claveEmail(email)),
      auditar(db, {
        accion: 'login.exito',
        usuarioId: usuario.id,
        usuarioEmail: usuario.email,
        ip,
      }),
    ])

    return json({ ok: true, expiraEn: expiraEn.toISOString() })
  }, 'POST /api/sesion')

export const DELETE: APIRoute = async ({ cookies, locals, request, clientAddress }) =>
  protegido(async () => {
    const db = base()
    const token = cookies.get(NOMBRE_COOKIE_SESION)?.value

    if (token !== undefined) await cerrarSesion(db, token)

    cookies.delete(NOMBRE_COOKIE_SESION, { path: '/' })
    cookies.delete(NOMBRE_COOKIE_CSRF, { path: '/' })

    await auditar(db, {
      accion: 'logout',
      usuarioId: locals.sesion?.usuarioId ?? null,
      usuarioEmail: locals.sesion?.email ?? null,
      ip: ipDelCliente(request, clientAddress),
    })

    return json({ ok: true })
  }, 'DELETE /api/sesion')
