import { useLayoutEffect, useRef, useState } from 'react'
import { CLAVES_RANGO, RANGOS, type ClaveRango } from '@vmstats/shared'

/* ============================================================================
 * Selector de rango temporal.
 *
 * Es la transición `tabs-sliding` de transitions.dev: la pastilla se mide en
 * el DOM y se tweenea entre posiciones. A diferencia de la navegación
 * principal, acá no hay efecto líquido — es un control secundario y no debería
 * competir por la atención con los datos que está filtrando.
 * ========================================================================== */

interface Props {
  valor: ClaveRango
  onCambiar: (rango: ClaveRango) => void
  /** Etiqueta accesible del grupo. */
  etiqueta?: string
}

export function SelectorRango({ valor, onCambiar, etiqueta = 'Rango temporal' }: Props) {
  const contenedor = useRef<HTMLDivElement>(null)
  const [pastilla, setPastilla] = useState({ x: 0, ancho: 0 })

  useLayoutEffect(() => {
    function medir() {
      const raiz = contenedor.current
      if (raiz === null) return
      const activo = raiz.querySelector<HTMLElement>(`[data-rango="${valor}"]`)
      if (activo === null) return
      setPastilla({ x: activo.offsetLeft - 3, ancho: activo.offsetWidth })
    }
    medir()

    const observador = new ResizeObserver(medir)
    if (contenedor.current !== null) observador.observe(contenedor.current)
    return () => observador.disconnect()
  }, [valor])

  return (
    <div
      ref={contenedor}
      role="tablist"
      aria-label={etiqueta}
      className="t-tabs border-border max-w-full flex-wrap border"
    >
      <span
        aria-hidden
        className="t-tabs-pill border-border border"
        style={{ transform: `translateX(${pastilla.x}px)`, width: pastilla.ancho }}
      />
      {CLAVES_RANGO.map((clave) => (
        <button
          key={clave}
          type="button"
          role="tab"
          aria-selected={clave === valor}
          data-rango={clave}
          onClick={() => onCambiar(clave)}
          className="t-tab text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          {RANGOS[clave].etiqueta}
        </button>
      ))}
    </div>
  )
}
