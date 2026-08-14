import { randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'

/* ============================================================================
 * Hashing de contraseñas.
 *
 * Vive en @vmstats/db y no en la app web porque es lo que produce el contenido
 * de la columna `password_hash`: pertenece al ciclo de vida de la tabla, igual
 * que las migraciones. Y hay una razón práctica además — el script que crea el
 * primer administrador tiene que poder correr en la imagen de producción, sin
 * `tsx` ni el fuente de Astro.
 * ========================================================================== */

/**
 * Valor de `Algorithm.Argon2id` de @node-rs/argon2.
 *
 * Se escribe el número en vez de importar el enum porque el paquete lo declara
 * como `const enum` ambiente, y `verbatimModuleSyntax` no permite acceder a
 * esos.
 */
const ARGON2ID = 2

/**
 * Parámetros de Argon2id.
 *
 * 19 MiB y 2 pasadas es la línea base recomendada por OWASP. En una VM chica el
 * login tarda unos 50 ms, aceptable para algo que ocurre una vez cada 30 días.
 */
const OPCIONES_ARGON = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashearContrasenia(contrasenia: string): Promise<string> {
  return argonHash(contrasenia, OPCIONES_ARGON)
}

export async function verificarContrasenia(
  hashGuardado: string,
  contrasenia: string,
): Promise<boolean> {
  try {
    return await argonVerify(hashGuardado, contrasenia)
  } catch {
    // Hash corrupto o de otro algoritmo: es un fallo de verificación, no una
    // excepción que deba propagarse al usuario.
    return false
  }
}

/**
 * Hash de descarte para el login de usuarios inexistentes.
 *
 * Se calcula una vez al arrancar sobre un valor aleatorio. Sirve para que
 * verificar un email que no existe cueste lo mismo que verificar uno que sí:
 * sin esto, la respuesta tarda 1 ms en un caso y 50 ms en el otro, y esa
 * diferencia permite enumerar qué cuentas son reales.
 *
 * Tiene que ser un hash de verdad, no una constante escrita a mano: un PHC
 * inválido haría que Argon2 falle de entrada y el trabajo no se haría.
 */
let promesaDescarte: Promise<string> | null = null

export function hashDeDescarte(): Promise<string> {
  promesaDescarte ??= hashearContrasenia(randomBytes(32).toString('hex'))
  return promesaDescarte
}

/**
 * Longitud mínima de la contraseña del administrador.
 *
 * 12 y no 8: es una cuenta de administración de infraestructura que casi nunca
 * se usa, así que el costo de una contraseña larga es bajo y el valor de lo que
 * protege es alto.
 */
export const LARGO_MINIMO_CONTRASENIA = 12
