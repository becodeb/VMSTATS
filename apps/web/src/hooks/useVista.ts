import { useCallback, useEffect, useState } from 'react'

/* ============================================================================
 * La vista activa vive en la URL.
 *
 * `/dashboard?view=containers` tiene que poder compartirse y sobrevivir a un
 * recargo. Se usa `replaceState` en vez de `pushState` para que cambiar de
 * pestaña no llene el historial: con `pushState`, el botón Atrás después de
 * mirar seis secciones exige seis toques para salir de la consola.
 *
 * `popstate` se escucha igual, para que Atrás funcione si el usuario llegó
 * desde otra página con un `?view=` distinto.
 * ========================================================================== */

export const PARAMETRO_VISTA = 'view'

/**
 * @param inicial La vista que el SERVIDOR leyó de la URL.
 *
 * Tiene que venir por prop y no leerse acá: en el servidor no hay `window`, así
 * que leer la URL desde el hook devolvía siempre la vista por defecto mientras
 * el cliente devolvía la del enlace. Con `?view=history`, servidor y cliente
 * renderizaban secciones distintas y React descartaba la hidratación entera.
 *
 * Un enlace compartido a una sección tiene que abrir esa sección ya renderizada
 * en el HTML, no después de que el navegador corrija.
 */
export function useVista<T extends string>(
  valores: readonly T[],
  porDefecto: T,
  inicial?: T,
): [T, (v: T) => void] {
  const leerDeUrl = useCallback((): T => {
    if (typeof window === 'undefined') return inicial ?? porDefecto
    const valor = new URL(window.location.href).searchParams.get(PARAMETRO_VISTA)
    return valores.includes(valor as T) ? (valor as T) : (inicial ?? porDefecto)
  }, [valores, porDefecto, inicial])

  const [vista, setVistaEstado] = useState<T>(inicial ?? porDefecto)

  useEffect(() => {
    const alVolver = () => setVistaEstado(leerDeUrl())
    window.addEventListener('popstate', alVolver)
    return () => window.removeEventListener('popstate', alVolver)
  }, [leerDeUrl])

  const setVista = useCallback((v: T) => {
    setVistaEstado(v)
    const url = new URL(window.location.href)
    url.searchParams.set(PARAMETRO_VISTA, v)
    window.history.replaceState(null, '', url)
  }, [])

  return [vista, setVista]
}
