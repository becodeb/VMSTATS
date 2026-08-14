import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import { intentosLogin, sesiones, usuarios, type BaseDatos } from '@vmstats/db'

/* El hashing vive en @vmstats/db: es lo que produce el contenido de
 * `password_hash`, y así el script que crea el primer administrador puede
 * correr en la imagen de producción sin el fuente de Astro. */
export {
  hashDeDescarte,
  hashearContrasenia,
  verificarContrasenia,
} from '@vmstats/db'

/* ============================================================================
 * Sesiones y contraseñas.
 *
 * Escrito a mano en vez de usar una librería de autenticación, por una razón
 * concreta: la spec exige que los tokens de sesión se guarden hasheados, y las
 * soluciones mantenidas que evaluamos (Better Auth) guardan el token en claro
 * en la columna `token`. El resto de los requisitos —Argon2id, rotación, CSRF,
 * rate limiting— también son específicos. La comparación completa está en
 * docs/security.md.
 *
 * El modelo es el clásico de Lucia:
 *   - el token vive SOLO en la cookie del navegador,
 *   - la base guarda su SHA-256,
 *   - un dump de la base no alcanza para hacerse pasar por nadie.
 * ========================================================================== */

export const NOMBRE_COOKIE_SESION = 'vmstats_sesion'
export const NOMBRE_COOKIE_CSRF = 'vmstats_csrf'

/** 30 días. Es una consola interna: sesiones largas, revocables desde la base. */
export const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A partir de acá la sesión se renueva sola.
 *
 * Rotar a mitad de vida evita dos cosas: que alguien que use la consola todos
 * los días tenga que volver a entrar cada 30 días, y que un token robado siga
 * siendo válido hasta el final del plazo original.
 */
const UMBRAL_ROTACION_MS = DURACION_SESION_MS / 2

/* -------------------------------------------------------------------------
 * Tokens
 * ---------------------------------------------------------------------- */

/** 32 bytes de entropía, en base64url para que entren limpios en una cookie. */
export function generarToken(): string {
  return randomBytes(32).toString('base64url')
}

/** El id de sesión en la base es el hash del token, nunca el token. */
export function idDeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface SesionActiva {
  id: string
  usuarioId: string
  email: string
  nombre: string
  rol: string
  expiraEn: Date
}

export interface SesionCreada {
  token: string
  expiraEn: Date
}

export async function crearSesion(
  db: BaseDatos,
  usuarioId: string,
  ip: string | null,
  agenteUsuario: string | null,
): Promise<SesionCreada> {
  const token = generarToken()
  const expiraEn = new Date(Date.now() + DURACION_SESION_MS)

  await db.insert(sesiones).values({
    id: idDeToken(token),
    usuarioId,
    expiraEn,
    ip,
    agenteUsuario,
  })

  return { token, expiraEn }
}

export interface ResultadoValidacion {
  sesion: SesionActiva | null
  /** Token nuevo si hubo rotación; el llamador tiene que reescribir la cookie. */
  tokenRotado: string | null
}

/**
 * Valida el token de la cookie contra la base.
 *
 * Devuelve `null` para token inexistente, vencido o de un usuario
 * deshabilitado — desde afuera los tres casos son indistinguibles, que es lo
 * que queremos.
 */
export async function validarSesion(
  db: BaseDatos,
  token: string,
): Promise<ResultadoValidacion> {
  const id = idDeToken(token)

  const filas = await db
    .select({
      id: sesiones.id,
      usuarioId: sesiones.usuarioId,
      expiraEn: sesiones.expiraEn,
      usadaEn: sesiones.usadaEn,
      email: usuarios.email,
      nombre: usuarios.nombre,
      rol: usuarios.rol,
      deshabilitadoEn: usuarios.deshabilitadoEn,
    })
    .from(sesiones)
    .innerJoin(usuarios, eq(sesiones.usuarioId, usuarios.id))
    .where(and(eq(sesiones.id, id), gt(sesiones.expiraEn, new Date())))
    .limit(1)

  const fila = filas[0]
  if (fila === undefined || fila.deshabilitadoEn !== null) {
    return { sesion: null, tokenRotado: null }
  }

  const sesion: SesionActiva = {
    id: fila.id,
    usuarioId: fila.usuarioId,
    email: fila.email,
    nombre: fila.nombre,
    rol: fila.rol,
    expiraEn: fila.expiraEn,
  }

  const restante = fila.expiraEn.getTime() - Date.now()
  if (restante > UMBRAL_ROTACION_MS) {
    // Sin rotación, sólo marcamos uso — y no en cada request: una consola con
    // SSE abierto haría un UPDATE por segundo sobre la misma fila.
    if (Date.now() - fila.usadaEn.getTime() > 60_000) {
      await db
        .update(sesiones)
        .set({ usadaEn: new Date() })
        .where(eq(sesiones.id, fila.id))
    }
    return { sesion, tokenRotado: null }
  }

  /* Rotación: token nuevo, fila nueva, la vieja se borra.
   *
   * Reemplazar la fila en vez de extenderle la fecha es lo que hace que un
   * token robado deje de servir: el atacante se queda con un id que ya no
   * existe en la tabla. */
  const nuevoToken = generarToken()
  const nuevaExpiracion = new Date(Date.now() + DURACION_SESION_MS)

  await db.transaction(async (tx) => {
    await tx.insert(sesiones).values({
      id: idDeToken(nuevoToken),
      usuarioId: fila.usuarioId,
      expiraEn: nuevaExpiracion,
    })
    await tx.delete(sesiones).where(eq(sesiones.id, fila.id))
  })

  return {
    sesion: { ...sesion, id: idDeToken(nuevoToken), expiraEn: nuevaExpiracion },
    tokenRotado: nuevoToken,
  }
}

export async function cerrarSesion(db: BaseDatos, token: string): Promise<void> {
  await db.delete(sesiones).where(eq(sesiones.id, idDeToken(token)))
}

/** Cierra todas las sesiones de un usuario. Se usa al cambiar la contraseña. */
export async function cerrarTodasLasSesiones(
  db: BaseDatos,
  usuarioId: string,
): Promise<void> {
  await db.delete(sesiones).where(eq(sesiones.usuarioId, usuarioId))
}

/* -------------------------------------------------------------------------
 * Rate limiting del login
 * ---------------------------------------------------------------------- */

export const VENTANA_LIMITE_MS = 15 * 60 * 1000
/** Una IP puede probar 20 veces en 15 minutos. */
export const MAX_INTENTOS_IP = 20
/** Una cuenta, 8: frena el ataque distribuido contra un usuario conocido. */
export const MAX_INTENTOS_EMAIL = 8

export function claveEmail(email: string): string {
  return `email:${email.toLowerCase()}`
}

export function claveIp(ip: string): string {
  return `ip:${ip}`
}

export async function registrarIntento(
  db: BaseDatos,
  clave: string,
  exitoso: boolean,
): Promise<void> {
  await db.insert(intentosLogin).values({ clave, exitoso })
}

/** Cuenta los intentos fallidos recientes de una clave. */
export async function intentosFallidos(db: BaseDatos, clave: string): Promise<number> {
  const desde = new Date(Date.now() - VENTANA_LIMITE_MS)
  const filas = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(intentosLogin)
    .where(
      and(
        eq(intentosLogin.clave, clave),
        eq(intentosLogin.exitoso, false),
        gt(intentosLogin.en, desde),
      ),
    )
  return filas[0]?.n ?? 0
}

/** Un login exitoso limpia el contador de esa cuenta. */
export async function limpiarIntentos(db: BaseDatos, clave: string): Promise<void> {
  await db.delete(intentosLogin).where(eq(intentosLogin.clave, clave))
}

export interface EstadoLimite {
  bloqueado: boolean
  /** Segundos hasta poder reintentar. 0 si no está bloqueado. */
  esperaSegundos: number
}

export async function comprobarLimite(
  db: BaseDatos,
  ip: string,
  email: string,
): Promise<EstadoLimite> {
  const [porIp, porEmail] = await Promise.all([
    intentosFallidos(db, claveIp(ip)),
    intentosFallidos(db, claveEmail(email)),
  ])

  const bloqueado = porIp >= MAX_INTENTOS_IP || porEmail >= MAX_INTENTOS_EMAIL
  return {
    bloqueado,
    esperaSegundos: bloqueado ? Math.ceil(VENTANA_LIMITE_MS / 1000) : 0,
  }
}

/* -------------------------------------------------------------------------
 * Comparación en tiempo constante
 * ---------------------------------------------------------------------- */

/**
 * Compara dos strings sin filtrar por tiempo cuánto prefijo coincide.
 *
 * Se usa para los tokens CSRF. Las longitudes distintas devuelven false de
 * entrada, lo que revela sólo la longitud — que no es secreta.
 */
export function igualdadSegura(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
