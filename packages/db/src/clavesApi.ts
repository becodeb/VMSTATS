import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import type { BaseDatos } from './index.js'
import { clavesApi, usuarios } from './schema.js'

/* ============================================================================
 * Claves de API: generación, validación y administración.
 *
 * Vive en @vmstats/db y no en la app web por la misma razón que el hashing de
 * contraseñas: se compila a JavaScript plano, así el CLI que emite una clave
 * funciona dentro de la imagen de producción sin el fuente de Astro.
 *
 * Mismo modelo criptográfico que las sesiones —la base guarda el SHA-256, el
 * secreto vive sólo en manos de quien lo creó— con dos diferencias deliberadas:
 *
 *  - No rotan solas. Una sesión rota porque hay un navegador que puede recibir
 *    la cookie nueva; un script no tiene dónde guardarla. Se revocan y se emite
 *    otra.
 *  - Tienen alcance, y el valor por defecto es `read`: lo habitual es leer
 *    métricas, no cambiar reglas.
 * ========================================================================== */

/** Prefijo visible. Sirve para reconocer un secreto filtrado en un log ajeno. */
export const PREFIJO_CLAVE = 'vmst_'

export const ALCANCES = ['read', 'admin'] as const
export type AlcanceClave = (typeof ALCANCES)[number]

export function esAlcance(valor: string): valor is AlcanceClave {
  return (ALCANCES as readonly string[]).includes(valor)
}

/** Longitud del prefijo que se guarda en claro para poder listar la clave. */
const LARGO_PREFIJO_VISIBLE = 8

export interface ClaveGenerada {
  /** El secreto completo. Es la única vez que existe fuera de quien lo pide. */
  secreto: string
  id: string
  prefijo: string
}

export function generarClave(): ClaveGenerada {
  const cuerpo = randomBytes(32).toString('base64url')
  const secreto = `${PREFIJO_CLAVE}${cuerpo}`
  return {
    secreto,
    id: idDeClave(secreto),
    prefijo: cuerpo.slice(0, LARGO_PREFIJO_VISIBLE),
  }
}

/** El identificador en la base es el hash del secreto, nunca el secreto. */
export function idDeClave(secreto: string): string {
  return createHash('sha256').update(secreto).digest('hex')
}

/* -------------------------------------------------------------------------
 * Validación
 * ---------------------------------------------------------------------- */

export interface ClaveActiva {
  id: string
  nombre: string
  alcance: AlcanceClave
  usuarioId: string
  email: string
  nombreUsuario: string
  rol: string
}

/** No escribimos `last_used_at` en cada request: un script que pollea haría un
 *  UPDATE por segundo sobre la misma fila. Mismo criterio que las sesiones. */
const UMBRAL_MARCA_USO_MS = 60_000

/**
 * Valida el secreto contra la base.
 *
 * Devuelve `null` para una clave inexistente, revocada, vencida o de un usuario
 * deshabilitado: desde afuera los cuatro casos son indistinguibles.
 */
export async function validarClave(
  db: BaseDatos,
  secreto: string,
): Promise<ClaveActiva | null> {
  const id = idDeClave(secreto)

  const filas = await db
    .select({
      id: clavesApi.id,
      nombre: clavesApi.nombre,
      alcance: clavesApi.alcance,
      usuarioId: clavesApi.usuarioId,
      usadaEn: clavesApi.usadaEn,
      email: usuarios.email,
      nombreUsuario: usuarios.nombre,
      rol: usuarios.rol,
      deshabilitadoEn: usuarios.deshabilitadoEn,
    })
    .from(clavesApi)
    .innerJoin(usuarios, eq(clavesApi.usuarioId, usuarios.id))
    .where(
      and(
        eq(clavesApi.id, id),
        isNull(clavesApi.revocadaEn),
        // `expires_at` nulo significa que no vence.
        or(isNull(clavesApi.expiraEn), sql`${clavesApi.expiraEn} > now()`),
      ),
    )
    .limit(1)

  const fila = filas[0]
  if (fila === undefined || fila.deshabilitadoEn !== null) return null

  // Una fila con un alcance que este binario no conoce se trata como inválida,
  // no como `read`: ante una base más nueva es más seguro fallar cerrado.
  if (!esAlcance(fila.alcance)) return null

  const usadaEn = fila.usadaEn
  if (usadaEn === null || Date.now() - usadaEn.getTime() > UMBRAL_MARCA_USO_MS) {
    await db.update(clavesApi).set({ usadaEn: new Date() }).where(eq(clavesApi.id, fila.id))
  }

  return {
    id: fila.id,
    nombre: fila.nombre,
    alcance: fila.alcance,
    usuarioId: fila.usuarioId,
    email: fila.email,
    nombreUsuario: fila.nombreUsuario,
    rol: fila.rol,
  }
}

/* -------------------------------------------------------------------------
 * Administración
 * ---------------------------------------------------------------------- */

export interface ClaveListada {
  id: string
  nombre: string
  prefijo: string
  alcance: string
  creadaEn: string
  expiraEn: string | null
  usadaEn: string | null
}

export async function listarClaves(
  db: BaseDatos,
  usuarioId: string,
): Promise<ClaveListada[]> {
  const filas = await db
    .select({
      id: clavesApi.id,
      nombre: clavesApi.nombre,
      prefijo: clavesApi.prefijo,
      alcance: clavesApi.alcance,
      creadaEn: clavesApi.creadaEn,
      expiraEn: clavesApi.expiraEn,
      usadaEn: clavesApi.usadaEn,
    })
    .from(clavesApi)
    // Las revocadas no se listan: la fila queda para que el hash no se pueda
    // reutilizar, pero para el usuario la clave ya no existe.
    .where(and(eq(clavesApi.usuarioId, usuarioId), isNull(clavesApi.revocadaEn)))
    .orderBy(desc(clavesApi.creadaEn))

  return filas.map((f) => ({
    id: f.id,
    nombre: f.nombre,
    prefijo: f.prefijo,
    alcance: f.alcance,
    creadaEn: f.creadaEn.toISOString(),
    expiraEn: f.expiraEn?.toISOString() ?? null,
    usadaEn: f.usadaEn?.toISOString() ?? null,
  }))
}

export interface OpcionesCreacion {
  usuarioId: string
  nombre: string
  alcance: AlcanceClave
  /** Días hasta el vencimiento. `null` = no vence. */
  diasValidez: number | null
}

export async function crearClave(
  db: BaseDatos,
  opciones: OpcionesCreacion,
): Promise<{ secreto: string; clave: ClaveListada }> {
  const { secreto, id, prefijo } = generarClave()
  const expiraEn =
    opciones.diasValidez === null
      ? null
      : new Date(Date.now() + opciones.diasValidez * 24 * 60 * 60 * 1000)

  const [fila] = await db
    .insert(clavesApi)
    .values({
      id,
      usuarioId: opciones.usuarioId,
      nombre: opciones.nombre,
      prefijo,
      alcance: opciones.alcance,
      expiraEn,
    })
    .returning({ creadaEn: clavesApi.creadaEn })

  return {
    secreto,
    clave: {
      id,
      nombre: opciones.nombre,
      prefijo,
      alcance: opciones.alcance,
      creadaEn: (fila?.creadaEn ?? new Date()).toISOString(),
      expiraEn: expiraEn?.toISOString() ?? null,
      usadaEn: null,
    },
  }
}

/**
 * Revoca una clave.
 *
 * Marca en vez de borrar: la fila es la garantía de que ese hash no vuelva a
 * validar nunca, y deja rastro de que la clave existió.
 *
 * Filtra por `usuarioId` dentro del mismo UPDATE: sin eso, conocer el id de la
 * clave de otro alcanzaría para revocársela.
 */
export async function revocarClave(
  db: BaseDatos,
  usuarioId: string,
  id: string,
): Promise<boolean> {
  const filas = await db
    .update(clavesApi)
    .set({ revocadaEn: new Date() })
    .where(
      and(
        eq(clavesApi.id, id),
        eq(clavesApi.usuarioId, usuarioId),
        isNull(clavesApi.revocadaEn),
      ),
    )
    .returning({ id: clavesApi.id })

  return filas.length > 0
}
