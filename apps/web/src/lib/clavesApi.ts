import { PREFIJO_CLAVE, type AlcanceClave } from '@vmstats/db'

/* ============================================================================
 * Claves de API: la parte que es HTTP.
 *
 * La generación, la validación y la administración viven en @vmstats/db —ver
 * el porqué allá— y se reexportan acá para que las rutas tengan un solo import.
 * Lo que queda en este archivo es lo que sólo tiene sentido frente a un pedido:
 * leer la cabecera y decidir si el alcance admite el método.
 * ========================================================================== */

export {
  ALCANCES,
  PREFIJO_CLAVE,
  crearClave,
  esAlcance,
  generarClave,
  idDeClave,
  listarClaves,
  revocarClave,
  validarClave,
  type AlcanceClave,
  type ClaveActiva,
  type ClaveListada,
} from '@vmstats/db'

export const CABECERA_AUTORIZACION = 'authorization'

/**
 * Métodos que puede usar cada alcance.
 *
 * `read` incluye HEAD además de GET porque un healthcheck razonable usa HEAD y
 * negárselo sería gratuito. No incluye OPTIONS: no hay CORS habilitado.
 */
export function alcancePermiteMetodo(alcance: AlcanceClave, metodo: string): boolean {
  if (alcance === 'admin') return true
  return metodo === 'GET' || metodo === 'HEAD'
}

/**
 * Extrae el secreto de una cabecera `Authorization`.
 *
 * Devuelve `null` para cualquier cosa que no sea un Bearer con nuestro prefijo.
 * Exigir el prefijo evita ir a la base por cada cabecera `Authorization` que no
 * tenga nada que ver con nosotros.
 */
export function secretoDeCabecera(cabecera: string | null): string | null {
  if (cabecera === null) return null

  const partes = cabecera.trim().split(/\s+/)
  if (partes.length !== 2) return null

  const [esquema, valor] = partes
  if (esquema === undefined || valor === undefined) return null
  if (esquema.toLowerCase() !== 'bearer') return null
  if (!valor.startsWith(PREFIJO_CLAVE)) return null

  return valor
}
