import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Tostadas de confirmación y error.
 *
 * Transición `toast` de transitions.dev. Se montan con `is-open` en el frame
 * siguiente para que la animación de entrada tenga desde dónde empezar; si se
 * montara ya abierta, el navegador no vería el cambio y no habría transición.
 *
 * La región es `aria-live="polite"` y no `assertive`: son confirmaciones de una
 * acción que el usuario acaba de hacer, no urgencias.
 * ========================================================================== */

export interface Tostada {
  id: number
  tipo: 'ok' | 'error'
  texto: string
}

const DURACION_MS = 4500

export function useTostadas() {
  const [tostadas, setTostadas] = useState<Tostada[]>([])
  const proximoId = useRef(1)
  const temporizadores = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const quitar = useCallback((id: number) => {
    setTostadas((previas) => previas.filter((t) => t.id !== id))
    const temporizador = temporizadores.current.get(id)
    if (temporizador !== undefined) {
      clearTimeout(temporizador)
      temporizadores.current.delete(id)
    }
  }, [])

  const mostrar = useCallback(
    (tipo: Tostada['tipo'], texto: string) => {
      const id = proximoId.current
      proximoId.current += 1
      setTostadas((previas) => [...previas, { id, tipo, texto }])
      temporizadores.current.set(id, setTimeout(() => quitar(id), DURACION_MS))
    },
    [quitar],
  )

  // Los temporizadores pendientes se limpian al desmontar: si no, disparan
  // sobre un componente que ya no existe.
  useEffect(() => {
    const pendientes = temporizadores.current
    return () => {
      for (const temporizador of pendientes.values()) clearTimeout(temporizador)
      pendientes.clear()
    }
  }, [])

  return { tostadas, mostrar, quitar }
}

export function Tostadas({
  tostadas,
  onCerrar,
}: {
  tostadas: readonly Tostada[]
  onCerrar: (id: number) => void
}) {
  return (
    <div
      aria-live="polite"
      aria-label="Notificaciones"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
    >
      {tostadas.map((t) => (
        <UnaTostada key={t.id} tostada={t} onCerrar={() => onCerrar(t.id)} />
      ))}
    </div>
  )
}

function UnaTostada({ tostada, onCerrar }: { tostada: Tostada; onCerrar: () => void }) {
  const [abierta, setAbierta] = useState(false)

  useEffect(() => {
    // Un frame de espera: sin esto el elemento nace en su estado final y la
    // transición de entrada no ocurre.
    const id = requestAnimationFrame(() => setAbierta(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const Icono = tostada.tipo === 'ok' ? CheckIcon : TriangleAlertIcon

  return (
    <div
      className={cn(
        't-toast bg-popover border-border pointer-events-auto flex max-w-sm items-start gap-2',
        'rounded-lg border px-3 py-2 text-sm',
        abierta && 'is-open',
        tostada.tipo === 'error' && 'border-critico/30',
      )}
    >
      <Icono
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tostada.tipo === 'ok' ? 'text-sano' : 'text-critico',
        )}
      />
      <span className="min-w-0 flex-1">{tostada.texto}</span>
      <button
        type="button"
        onClick={onCerrar}
        aria-label="Cerrar notificación"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm outline-none focus-visible:ring-2"
      >
        <XIcon aria-hidden className="size-4" />
      </button>
    </div>
  )
}
