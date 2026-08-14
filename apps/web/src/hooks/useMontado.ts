import { useEffect, useState } from 'react'

/**
 * `false` en el servidor y en el primer render del cliente; `true` después.
 *
 * Sirve para todo lo que se calcula contra el reloj actual. El servidor
 * renderiza en un instante y el navegador hidrata en otro, así que cualquier
 * texto derivado de `Date.now()` puede diferir entre los dos árboles y hacer
 * que React descarte la hidratación entera.
 *
 * La regla en este proyecto: si lo que se muestra depende de «ahora», se
 * dibuja recién cuando este hook devuelve `true`.
 */
export function useMontado(): boolean {
  const [montado, setMontado] = useState(false)
  useEffect(() => setMontado(true), [])
  return montado
}
