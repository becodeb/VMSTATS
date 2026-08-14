import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/* Convención shadcn/ui, escrito a mano.
 *
 * Las variantes son deliberadamente pocas: es una consola, no un sitio de
 * marketing. `primary` sólo para la acción principal de un formulario; casi
 * todo lo demás es `ghost` u `outline`. */
const variantes = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium',
    'transition-colors outline-none disabled:pointer-events-none disabled:opacity-50',
    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2',
    'focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0',
  ),
  {
    variants: {
      variante: {
        primario: 'bg-primary text-primary-foreground hover:bg-primary/90',
        contorno: 'border-border hover:bg-accent hover:text-accent-foreground border bg-transparent',
        fantasma: 'hover:bg-accent hover:text-accent-foreground',
        destructivo: 'bg-destructive hover:bg-destructive/90 text-white',
        enlace: 'text-primary underline-offset-4 hover:underline',
      },
      tamanio: {
        sm: 'h-8 px-3 [&_svg]:size-3.5',
        md: 'h-9 px-4 [&_svg]:size-4',
        icono: 'size-9 [&_svg]:size-4',
        iconoSm: 'size-8 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variante: 'contorno', tamanio: 'md' },
  },
)

export type PropsBoton = ComponentProps<'button'> & VariantProps<typeof variantes>

export function Button({ className, variante, tamanio, ...props }: PropsBoton) {
  return (
    <button
      type="button"
      className={cn(variantes({ variante, tamanio }), className)}
      {...props}
    />
  )
}

export { variantes as variantesBoton }
