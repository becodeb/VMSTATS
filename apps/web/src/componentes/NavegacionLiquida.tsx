import { useLayoutEffect, useRef, useState } from 'react'
import { Liquid } from 'liquid-gooey'
import { cn } from '@/lib/utils'

export interface Pestania {
  id: string
  etiqueta: string
  /** Cantidad a mostrar al lado de la etiqueta (alertas abiertas, por ejemplo). */
  contador?: number
}

interface Props {
  pestanias: readonly Pestania[]
  activa: string
  onCambiar: (id: string) => void
}

/**
 * Las secciones de la consola, con el indicador activo trailando como goma
 * líquida detrás del cursor.
 *
 * Portado de Panky conservando la anatomía completa: pastilla `liquid-gooey`,
 * medición con `ResizeObserver`, `role="tablist"`, soporte de pestañas que
 * envuelven, y salto sin física con `prefers-reduced-motion`.
 *
 * Es el único lugar de vmstats donde el efecto hace un trabajo: marca de dónde
 * a dónde se movió el foco, que en una barra de pestañas idénticas es
 * información real. En el resto de la consola las animaciones comunican
 * cambios de estado, no transiciones de navegación.
 */
export function NavegacionLiquida({ pestanias, activa, onCambiar }: Props) {
  const contenedor = useRef<HTMLDivElement>(null)
  const [indicador, setIndicador] = useState({ x: 0, y: 0, ancho: 0, alto: 36 })
  const [sinMovimiento, setSinMovimiento] = useState(false)

  useLayoutEffect(() => {
    const consulta = window.matchMedia('(prefers-reduced-motion: reduce)')
    const aplicar = () => setSinMovimiento(consulta.matches)
    aplicar()
    consulta.addEventListener('change', aplicar)
    return () => consulta.removeEventListener('change', aplicar)
  }, [])

  useLayoutEffect(() => {
    function medir() {
      const raiz = contenedor.current
      if (raiz === null) return
      const boton = raiz.querySelector<HTMLElement>(`[data-pestania="${activa}"]`)
      if (boton === null) return
      // offsetLeft/Top ya incluyen el padding del contenedor, así que la capa
      // del indicador va en inset-0. Con inset-1 el padding se contaría dos
      // veces y la pastilla quedaría corrida.
      setIndicador({
        x: boton.offsetLeft,
        y: boton.offsetTop,
        ancho: boton.offsetWidth,
        alto: boton.offsetHeight,
      })
    }
    medir()

    const observador = new ResizeObserver(medir)
    if (contenedor.current !== null) observador.observe(contenedor.current)
    // Las pestañas envuelven en pantalla angosta: hay que remedir al cambiar,
    // porque al pasar a dos filas cambia el `offsetTop` de las de abajo.
    for (const boton of contenedor.current?.querySelectorAll('[data-pestania]') ?? []) {
      observador.observe(boton)
    }
    return () => observador.disconnect()
  }, [activa, pestanias])

  /* Negro sobre claro y blanco sobre oscuro: `foreground`/`background` se dan
   * vuelta solos con el tema. El azul de marca queda para botones y acentos;
   * acá la pastilla se lee mejor en neutro. */
  const pastilla = (
    <div
      className="bg-foreground rounded-full"
      style={{
        width: indicador.ancho,
        height: indicador.alto,
        transform: `translate(${indicador.x}px, ${indicador.y}px)`,
        transition: sinMovimiento
          ? 'none'
          : 'transform .34s cubic-bezier(.32,.72,0,1), width .34s cubic-bezier(.32,.72,0,1)',
      }}
    />
  )

  return (
    <div
      ref={contenedor}
      role="tablist"
      aria-label="Secciones"
      className="bg-muted relative inline-flex max-w-full flex-wrap justify-center rounded-full p-1"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {sinMovimiento ? (
          pastilla
        ) : (
          <Liquid blur={5} contrast={16} fill="var(--color-foreground)" filterPadding={28}>
            <Liquid.Item effect="move" move={{ springiness: 0.55, trail: 0.5 }}>
              {pastilla}
            </Liquid.Item>
          </Liquid>
        )}
      </div>

      {pestanias.map((p) => {
        const seleccionada = p.id === activa
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={seleccionada}
            aria-controls={`panel-${p.id}`}
            id={`pestania-${p.id}`}
            data-pestania={p.id}
            onClick={() => onCambiar(p.id)}
            className={cn(
              'relative z-10 flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium',
              'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              seleccionada ? 'text-background' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {p.etiqueta}
            {p.contador !== undefined && p.contador > 0 && (
              <span
                className={cn(
                  'cifra rounded-full px-1.5 py-px text-[0.6875rem] leading-none font-semibold',
                  seleccionada ? 'bg-background/25 text-background' : 'bg-critico/15 text-critico',
                )}
              >
                {p.contador}
                <span className="solo-lectores"> sin resolver</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
