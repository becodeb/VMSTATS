import { useEffect, useId, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Desplegable de filtro.
 *
 * Usa la transición `menu-dropdown` de transitions.dev, incluido el estado
 * `is-closing` — que existe porque al cerrar hay que dejar correr la animación
 * antes de desmontar.
 *
 * Patrón de accesibilidad: botón + `listbox`. Flechas para moverse, Enter o
 * Espacio para elegir, Escape para cerrar, Home y Fin para los extremos, y el
 * foco vuelve al botón al cerrar.
 * ========================================================================== */

export interface OpcionDesplegable {
  valor: string
  etiqueta: string
  /** Cantidad al lado de la etiqueta. */
  contador?: number
}

interface Props {
  etiqueta: string
  opciones: readonly OpcionDesplegable[]
  valor: string
  onCambiar: (valor: string) => void
  className?: string
}

export function Desplegable({ etiqueta, opciones, valor, onCambiar, className }: Props) {
  const [abierto, setAbierto] = useState(false)
  const [cerrando, setCerrando] = useState(false)
  const [resaltado, setResaltado] = useState(0)

  const raiz = useRef<HTMLDivElement>(null)
  const disparador = useRef<HTMLButtonElement>(null)
  const lista = useRef<HTMLUListElement>(null)
  const idLista = useId()

  const seleccionada = opciones.find((o) => o.valor === valor)

  function cerrar(devolverFoco = true): void {
    if (!abierto) return
    setCerrando(true)
    setAbierto(false)
    if (devolverFoco) disparador.current?.focus()
    // 150 ms = --dropdown-close-dur. Se desmonta recién cuando terminó.
    setTimeout(() => setCerrando(false), 150)
  }

  function abrir(): void {
    setResaltado(Math.max(0, opciones.findIndex((o) => o.valor === valor)))
    setAbierto(true)
    setCerrando(false)
  }

  useEffect(() => {
    if (!abierto) return

    const alTocar = (e: PointerEvent) => {
      if (raiz.current?.contains(e.target as Node) !== true) cerrar(false)
    }
    document.addEventListener('pointerdown', alTocar)
    return () => document.removeEventListener('pointerdown', alTocar)
    // `cerrar` es estable en la práctica: sólo toca estado local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto])

  useEffect(() => {
    if (!abierto) return
    lista.current?.querySelector<HTMLElement>(`[data-indice="${resaltado}"]`)?.focus()
  }, [abierto, resaltado])

  function alTeclearLista(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      cerrar()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setResaltado((i) => (i + 1) % opciones.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setResaltado((i) => (i - 1 + opciones.length) % opciones.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setResaltado(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setResaltado(opciones.length - 1)
    } else if (e.key === 'Tab') {
      cerrar(false)
    }
  }

  function elegir(opcion: OpcionDesplegable): void {
    onCambiar(opcion.valor)
    cerrar()
  }

  return (
    <div ref={raiz} className={cn('relative', className)}>
      <Button
        ref={disparador}
        tamanio="sm"
        variante="contorno"
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-controls={abierto ? idLista : undefined}
        onClick={() => (abierto ? cerrar() : abrir())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !abierto) {
            e.preventDefault()
            abrir()
          }
        }}
      >
        <span className="text-muted-foreground">{etiqueta}</span>
        <span className="font-medium">{seleccionada?.etiqueta ?? '—'}</span>
        <ChevronDownIcon aria-hidden />
      </Button>

      {(abierto || cerrando) && (
        <ul
          ref={lista}
          id={idLista}
          role="listbox"
          aria-label={etiqueta}
          onKeyDown={alTeclearLista}
          className={cn(
            't-dropdown bg-popover border-border absolute top-full left-0 z-30 mt-1',
            'max-h-64 min-w-[12rem] overflow-y-auto rounded-md border py-1',
            abierto && 'is-open',
            cerrando && 'is-closing',
          )}
        >
          {opciones.map((opcion, i) => {
            const elegida = opcion.valor === valor
            return (
              <li key={opcion.valor}>
                <button
                  type="button"
                  role="option"
                  aria-selected={elegida}
                  data-indice={i}
                  tabIndex={i === resaltado ? 0 : -1}
                  onClick={() => elegir(opcion)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none',
                    'hover:bg-accent focus:bg-accent transition-colors',
                  )}
                >
                  <CheckIcon
                    aria-hidden
                    className={cn('size-3.5 shrink-0', elegida ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="flex-1">{opcion.etiqueta}</span>
                  {opcion.contador !== undefined && (
                    <span className="cifra text-muted-foreground text-xs">
                      {opcion.contador}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
