/* ============================================================================
 * Conversión de valores que vienen de SQL crudo.
 *
 * Con el query builder de Drizzle, una columna `timestamptz` llega como `Date`.
 * Con `db.execute(sql\`…\`)` no hay garantía: depende de los parsers de tipo del
 * driver, y en la práctica llega como string. El tipo de TypeScript dice `Date`
 * igual, porque es una aserción sobre una fila sin tipar — así que el error
 * aparece recién en runtime, y sólo si alguien ejecuta ese endpoint.
 *
 * Pasó exactamente eso: `/api/contenedores` devolvía 500 con
 * «fila.ts.toISOString is not a function». Estas funciones son el lugar único
 * donde se resuelve.
 * ========================================================================== */

/** Fecha desde lo que sea que haya devuelto el driver. */
export function aFecha(valor: unknown): Date {
  if (valor instanceof Date) return valor
  if (typeof valor === 'string' || typeof valor === 'number') {
    const fecha = new Date(valor)
    if (!Number.isNaN(fecha.getTime())) return fecha
  }
  // Fecha inválida en vez de lanzar: el llamador la formatea como «—» y el
  // resto de la fila se sigue mostrando.
  return new Date(Number.NaN)
}

/** ISO 8601, o `null` si el valor no era una fecha. */
export function aIso(valor: unknown): string | null {
  const fecha = aFecha(valor)
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString()
}

/**
 * Número desde lo que sea que haya devuelto el driver.
 *
 * `numeric` y `bigint` llegan como string para no perder precisión. Los valores
 * de vmstats (bytes, segundos, porcentajes) están muy por debajo de 2^53.
 */
export function aNumero(valor: unknown, porDefecto = 0): number {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : porDefecto
  if (typeof valor === 'string') {
    const n = Number.parseFloat(valor)
    return Number.isFinite(n) ? n : porDefecto
  }
  return porDefecto
}

export function aNumeroOpcional(valor: unknown): number | null {
  if (valor === null || valor === undefined) return null
  const n = aNumero(valor, Number.NaN)
  return Number.isFinite(n) ? n : null
}
