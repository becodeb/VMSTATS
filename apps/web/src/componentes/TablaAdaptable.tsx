import { useId, useState, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Tabla que en móvil deja de ser tabla.
 *
 * La regla dura del proyecto es que la página nunca scrollea horizontalmente, y
 * `overflow-x: auto` está explícitamente descartado como salida: esconde datos
 * detrás de un gesto que en un teléfono compite con el scroll de la página.
 *
 * Acá, en pantalla angosta cada fila se convierte en una tarjeta con las
 * columnas principales visibles y el resto detrás de un desplegable. En
 * pantalla ancha es una `<table>` de verdad, con `<th scope>` y `<caption>`.
 *
 * Son dos árboles distintos en el DOM, uno oculto por CSS. Es más marcado que
 * una sola tabla con clases responsive, pero es la única forma de que ambas
 * versiones sean semánticamente correctas: una tabla con `display: block` en
 * los `<tr>` pierde su semántica de tabla para el lector de pantalla.
 * ========================================================================== */

export interface Columna<T> {
  clave: string
  etiqueta: string
  /** Contenido de la celda. */
  render: (fila: T) => ReactNode
  /**
   * `principal`: se ve siempre, también en la tarjeta móvil.
   * `secundaria`: en móvil queda detrás del desplegable.
   */
  prioridad?: 'principal' | 'secundaria'
  /** Alinea a la derecha. Para columnas numéricas. */
  numerica?: boolean
  className?: string
}

interface Props<T> {
  /** Descripción de la tabla para lectores de pantalla. */
  titulo: string
  columnas: readonly Columna<T>[]
  filas: readonly T[]
  clave: (fila: T) => string
  /** Encabezado de la tarjeta en móvil. Suele ser el nombre. */
  tituloFila: (fila: T) => ReactNode
  /** Se llama al activar una fila. La hace interactiva. */
  onSeleccionar?: (fila: T) => void
  vacio?: ReactNode
}

export function TablaAdaptable<T>({
  titulo,
  columnas,
  filas,
  clave,
  tituloFila,
  onSeleccionar,
  vacio,
}: Props<T>) {
  if (filas.length === 0 && vacio !== undefined) return <>{vacio}</>

  const principales = columnas.filter((c) => c.prioridad !== 'secundaria')
  const secundarias = columnas.filter((c) => c.prioridad === 'secundaria')

  return (
    <>
      {/* Ancho: tabla real. */}
      <table className="hidden w-full text-left text-sm md:table">
        <caption className="solo-lectores">{titulo}</caption>
        <thead className="text-muted-foreground border-border border-b text-xs">
          <tr>
            {columnas.map((c) => (
              <th
                key={c.clave}
                scope="col"
                className={cn(
                  'py-1.5 pr-3 font-medium',
                  c.numerica === true && 'text-right',
                  c.className,
                )}
              >
                {c.etiqueta}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {filas.map((fila) => (
            <tr
              key={clave(fila)}
              className={cn(
                onSeleccionar !== undefined &&
                  'hover:bg-muted/50 cursor-pointer transition-colors',
              )}
              {...(onSeleccionar === undefined
                ? {}
                : {
                    onClick: () => onSeleccionar(fila),
                    tabIndex: 0,
                    role: 'button' as const,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSeleccionar(fila)
                      }
                    },
                  })}
            >
              {columnas.map((c) => (
                <td
                  key={c.clave}
                  className={cn('py-2 pr-3', c.numerica === true && 'cifra text-right')}
                >
                  {c.render(fila)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Angosto: tarjetas. */}
      <ul className="divide-border divide-y md:hidden">
        {filas.map((fila) => (
          <Tarjeta
            key={clave(fila)}
            fila={fila}
            titulo={tituloFila(fila)}
            principales={principales}
            secundarias={secundarias}
            {...(onSeleccionar === undefined ? {} : { onSeleccionar })}
          />
        ))}
      </ul>
    </>
  )
}

interface PropsTarjeta<T> {
  fila: T
  titulo: ReactNode
  principales: readonly Columna<T>[]
  secundarias: readonly Columna<T>[]
  onSeleccionar?: (fila: T) => void
}

function Tarjeta<T>({
  fila,
  titulo,
  principales,
  secundarias,
  onSeleccionar,
}: PropsTarjeta<T>) {
  const [abierta, setAbierta] = useState(false)
  const idDetalle = useId()

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {onSeleccionar === undefined ? (
            <span className="block text-sm font-medium">{titulo}</span>
          ) : (
            <button
              type="button"
              onClick={() => onSeleccionar(fila)}
              className="focus-visible:ring-ring block w-full rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2"
            >
              {titulo}
            </button>
          )}

          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
            {principales.map((c) => (
              <div key={c.clave} className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground text-xs">{c.etiqueta}</dt>
                <dd className="cifra text-xs">{c.render(fila)}</dd>
              </div>
            ))}
          </dl>
        </div>

        {secundarias.length > 0 && (
          <button
            type="button"
            onClick={() => setAbierta((v) => !v)}
            aria-expanded={abierta}
            aria-controls={idDetalle}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-md p-1 outline-none focus-visible:ring-2"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn(
                'size-4 transition-transform duration-200 motion-reduce:transition-none',
                abierta && 'rotate-180',
              )}
            />
            <span className="solo-lectores">
              {abierta ? 'Ocultar detalle' : 'Ver detalle'}
            </span>
          </button>
        )}
      </div>

      {secundarias.length > 0 && (
        <dl id={idDetalle} hidden={!abierta} className="mt-2 flex flex-col gap-1 pl-1">
          {secundarias.map((c) => (
            <div key={c.clave} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground text-xs">{c.etiqueta}</dt>
              <dd className="cifra text-xs">{c.render(fila)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}
