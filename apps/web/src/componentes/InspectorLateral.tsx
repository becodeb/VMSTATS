import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Inspector lateral.
 *
 * Usa la transición `panel-reveal` de transitions.dev, que entra desde abajo en
 * móvil y desde el costado en escritorio (ver `global.css`).
 *
 * La accesibilidad de un panel como éste no la da el CSS, así que está toda
 * acá y a mano:
 *
 *  - `role="dialog"` con `aria-modal` y título asociado.
 *  - Trampa de foco: Tab cicla dentro del panel y no se escapa al fondo.
 *  - Escape cierra.
 *  - Al cerrar, el foco vuelve al elemento que lo abrió. Sin esto, quien
 *    navega con teclado queda al principio del documento y tiene que recorrer
 *    toda la tabla de nuevo.
 *  - El contenido de atrás queda inerte mientras está abierto.
 * ========================================================================== */

/** Elementos que pueden recibir foco con Tab. */
const FOCALIZABLES = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface Props {
  abierto: boolean
  titulo: string
  subtitulo?: ReactNode
  onCerrar: () => void
  children: ReactNode
}

export function InspectorLateral({ abierto, titulo, subtitulo, onCerrar, children }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const devolverFocoA = useRef<HTMLElement | null>(null)
  const idTitulo = useId()

  const alTeclear = useCallback(
    (evento: KeyboardEvent) => {
      if (!abierto) return

      if (evento.key === 'Escape') {
        evento.preventDefault()
        onCerrar()
        return
      }

      if (evento.key !== 'Tab') return

      const raiz = panel.current
      if (raiz === null) return

      const focalizables = [...raiz.querySelectorAll<HTMLElement>(FOCALIZABLES)].filter(
        (el) => el.offsetParent !== null,
      )
      const primero = focalizables[0]
      const ultimo = focalizables[focalizables.length - 1]
      if (primero === undefined || ultimo === undefined) return

      // El ciclo se cierra a mano en los dos extremos: sin esto, Tab en el
      // último elemento salta a la barra del navegador y de ahí al contenido
      // de atrás, que está oculto pero sigue siendo tabulable.
      if (evento.shiftKey && document.activeElement === primero) {
        evento.preventDefault()
        ultimo.focus()
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault()
        primero.focus()
      }
    },
    [abierto, onCerrar],
  )

  useEffect(() => {
    if (!abierto) return

    devolverFocoA.current = document.activeElement as HTMLElement | null

    // Se enfoca el panel, no el primer botón: así el lector de pantalla lee el
    // título antes que el control de cerrar.
    const foco = requestAnimationFrame(() => panel.current?.focus())

    document.addEventListener('keydown', alTeclear)

    return () => {
      cancelAnimationFrame(foco)
      document.removeEventListener('keydown', alTeclear)
      devolverFocoA.current?.focus()
    }
  }, [abierto, alTeclear])

  return (
    <>
      {/* Fondo: cierra al tocar afuera. No lleva rol ni foco — es decorativo y
          la vía accesible para cerrar es Escape o el botón. */}
      <div
        aria-hidden
        onClick={onCerrar}
        className={cn(
          'fixed inset-0 z-30 bg-black/20 transition-opacity duration-300 motion-reduce:transition-none',
          abierto ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        tabIndex={-1}
        // `inert` mientras está cerrado: el contenido no es tabulable ni
        // visible para lectores aunque siga en el DOM por la transición.
        {...(abierto ? {} : { inert: true })}
        data-open={abierto}
        className={cn(
          't-panel-slide bg-card border-border fixed z-40 flex flex-col overflow-hidden outline-none',
          'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t',
          'lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-[32rem] lg:rounded-none lg:border-t-0 lg:border-l',
        )}
      >
        <div className="border-border flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 id={idTitulo} className="truncate text-sm font-medium">
              {titulo}
            </h2>
            {subtitulo !== undefined && (
              <p className="text-muted-foreground truncate text-xs">{subtitulo}</p>
            )}
          </div>
          <Button variante="fantasma" tamanio="iconoSm" onClick={onCerrar} aria-label="Cerrar">
            <XIcon aria-hidden />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
      </div>
    </>
  )
}
