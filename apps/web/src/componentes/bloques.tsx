import type { ReactNode } from 'react'
import type { EstadoGeneral } from '@vmstats/shared'
import { Barra } from '@/componentes/estado'
import { Cifra } from '@/componentes/Cifra'
import { Pista } from '@/components/ui/pista'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Bloques de la consola.
 *
 * La dirección visual es «consola editorial»: bloques horizontales separados
 * por divisores finos, no una grilla de tarjetas iguales. Por eso `Bloque` no
 * dibuja una caja — dibuja un encabezado y una línea. Las tarjetas aparecen
 * sólo donde un elemento es realmente independiente (un contenedor, una
 * alerta), no para envolver cada dato.
 * ========================================================================== */

interface PropsBloque {
  titulo: string
  /** Aclaración corta a la derecha del título. */
  nota?: ReactNode
  acciones?: ReactNode
  children: ReactNode
  className?: string
}

export function Bloque({ titulo, nota, acciones, children, className }: PropsBloque) {
  return (
    <section className={cn('flex flex-col gap-3', className)} aria-label={titulo}>
      <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-2">
        <h2 className="text-sm font-medium tracking-tight">{titulo}</h2>
        {nota !== undefined && (
          <span className="text-muted-foreground text-xs">{nota}</span>
        )}
        {acciones !== undefined && <div className="ml-auto flex items-center gap-2">{acciones}</div>}
      </div>
      {children}
    </section>
  )
}

/* -------------------------------------------------------------------------
 * Métrica principal
 * ---------------------------------------------------------------------- */

interface PropsMetrica {
  etiqueta: string
  /** Valor ya formateado. */
  valor: string
  /** El número crudo, para decidir si la cifra se anima. */
  crudo?: number | null
  /** Segunda línea: el contexto que hace interpretable al número. */
  contexto?: ReactNode
  porcentaje?: number | null
  estado?: EstadoGeneral
  /** Definición para el tooltip. */
  explicacion?: string
  className?: string
}

/**
 * Un número grande con su contexto.
 *
 * El contexto no es decorativo: la spec pide evitar «números gigantes sin
 * contexto», y un 62 % de memoria sin saber que son 9,9 GiB de 16 GiB no le
 * sirve a nadie para decidir nada.
 */
export function Metrica({
  etiqueta,
  valor,
  crudo = null,
  contexto,
  porcentaje = null,
  estado = 'saludable',
  explicacion,
  className,
}: PropsMetrica) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-muted-foreground text-xs">
        {explicacion === undefined ? (
          etiqueta
        ) : (
          <Pista explicacion={explicacion}>{etiqueta}</Pista>
        )}
      </span>

      <Cifra
        texto={valor}
        valor={crudo}
        className="text-2xl leading-none font-medium tracking-tight"
      />

      {porcentaje !== null && (
        <Barra porcentaje={porcentaje} estado={estado} etiqueta={etiqueta} />
      )}

      {contexto !== undefined && (
        <span className="text-muted-foreground truncate text-xs">{contexto}</span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Fila de dato
 * ---------------------------------------------------------------------- */

/** Par etiqueta / valor para las listas densas. */
export function Dato({
  etiqueta,
  valor,
  explicacion,
}: {
  etiqueta: string
  valor: ReactNode
  explicacion?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground min-w-0 truncate text-xs">
        {explicacion === undefined ? (
          etiqueta
        ) : (
          <Pista explicacion={explicacion}>{etiqueta}</Pista>
        )}
      </span>
      <span className="cifra shrink-0 text-sm">{valor}</span>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Estados vacíos
 * ---------------------------------------------------------------------- */

/**
 * Estado vacío.
 *
 * Siempre dice por qué está vacío y, cuando corresponde, qué hacer. Un «no hay
 * datos» a secas obliga a adivinar si el sistema está sano, roto o mal
 * configurado.
 */
export function Vacio({
  titulo,
  detalle,
  accion,
}: {
  titulo: string
  detalle?: string
  accion?: ReactNode
}) {
  return (
    <div className="border-border text-muted-foreground flex flex-col items-start gap-2 rounded-lg border border-dashed px-4 py-6 text-sm">
      <span className="text-foreground font-medium">{titulo}</span>
      {detalle !== undefined && <span className="max-w-prose">{detalle}</span>}
      {accion}
    </div>
  )
}

/** Sección que este host no puede reportar. Distinto de «vacío». */
export function NoDisponible({ que, porque }: { que: string; porque: string }) {
  return (
    <div className="border-border text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-sm">
      <span className="text-foreground font-medium">{que}: no disponible</span>
      <p className="mt-1 max-w-prose">{porque}</p>
    </div>
  )
}
