import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Primitivas chicas.
 *
 * Están juntas a propósito: son de diez líneas cada una y repartirlas en seis
 * archivos con su import propio agrega navegación sin agregar claridad.
 * ========================================================================== */

/* --- Etiqueta ------------------------------------------------------------ */

const variantesEtiqueta = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variante: {
        neutra: 'border-border bg-muted text-muted-foreground',
        sana: 'border-sano/25 bg-sano-suave text-sano',
        aviso: 'border-aviso/25 bg-aviso-suave text-aviso',
        critica: 'border-critico/25 bg-critico-suave text-critico',
        contorno: 'border-border text-foreground bg-transparent',
      },
    },
    defaultVariants: { variante: 'neutra' },
  },
)

export type PropsEtiqueta = ComponentProps<'span'> & VariantProps<typeof variantesEtiqueta>

export function Etiqueta({ className, variante, ...props }: PropsEtiqueta) {
  return <span className={cn(variantesEtiqueta({ variante }), className)} {...props} />
}

/* --- Esqueleto ----------------------------------------------------------- */

export function Esqueleto({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      className={cn('bg-muted animate-pulse rounded-md motion-reduce:animate-none', className)}
      {...props}
    />
  )
}

/* --- Campo de texto ------------------------------------------------------ */

export function Campo({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'border-input bg-card h-9 w-full rounded-md border px-3 py-1 text-sm',
        'placeholder:text-muted-foreground transition-colors outline-none',
        'focus-visible:ring-ring focus-visible:border-ring focus-visible:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
        className,
      )}
      {...props}
    />
  )
}

export function Rotulo({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn('text-foreground text-sm leading-none font-medium', className)}
      {...props}
    />
  )
}

/* --- Aviso --------------------------------------------------------------- */

const variantesAviso = cva('rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variante: {
      neutro: 'border-border bg-muted/50 text-foreground',
      aviso: 'border-aviso/30 bg-aviso-suave text-foreground',
      critico: 'border-critico/30 bg-critico-suave text-foreground',
    },
  },
  defaultVariants: { variante: 'neutro' },
})

export type PropsAviso = ComponentProps<'div'> & VariantProps<typeof variantesAviso>

export function Aviso({ className, variante, ...props }: PropsAviso) {
  return <div className={cn(variantesAviso({ variante }), className)} {...props} />
}

export function AvisoTitulo({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mb-1 font-medium', className)} {...props} />
}

export function AvisoTexto({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-muted-foreground text-sm', className)} {...props} />
}

/* --- Separador ----------------------------------------------------------- */

export function Separador({ className, ...props }: ComponentProps<'hr'>) {
  return <hr className={cn('border-border border-t', className)} {...props} />
}
