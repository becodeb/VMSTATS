import {
  AlertTriangleIcon,
  CheckIcon,
  CircleHelpIcon,
  OctagonAlertIcon,
} from 'lucide-react'
import type { EstadoGeneral } from '@vmstats/shared'
import { ETIQUETA_ESTADO } from '@vmstats/shared'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Indicadores de estado.
 *
 * Regla de accesibilidad que atraviesa todo el archivo: el estado NUNCA se
 * comunica sólo por color. Cada indicador lleva ícono distinto y texto — un
 * punto verde y uno rojo son idénticos para quien no distingue esos dos
 * colores, y son la mitad de la población daltónica.
 * ========================================================================== */

const ICONOS = {
  saludable: CheckIcon,
  advertencia: AlertTriangleIcon,
  critico: OctagonAlertIcon,
  'sin-datos': CircleHelpIcon,
} as const

const COLORES: Record<EstadoGeneral, string> = {
  saludable: 'text-sano',
  advertencia: 'text-aviso',
  critico: 'text-critico',
  'sin-datos': 'text-neutro',
}

const FONDOS: Record<EstadoGeneral, string> = {
  saludable: 'bg-sano-suave border-sano/25',
  advertencia: 'bg-aviso-suave border-aviso/25',
  critico: 'bg-critico-suave border-critico/25',
  'sin-datos': 'bg-neutro-suave border-border',
}

interface PropsIndicador {
  estado: EstadoGeneral
  /** Texto propio; si falta, se usa la etiqueta estándar del estado. */
  texto?: string
  className?: string
}

/** Pastilla con ícono y texto. Para el estado general de la franja superior. */
export function IndicadorEstado({ estado, texto, className }: PropsIndicador) {
  const Icono = ICONOS[estado]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium',
        FONDOS[estado],
        COLORES[estado],
        className,
      )}
    >
      <Icono aria-hidden className="size-3.5" />
      {texto ?? ETIQUETA_ESTADO[estado]}
    </span>
  )
}

/**
 * Punto de estado para tablas y listas densas.
 *
 * Acompañado siempre de texto visible al lado. Cuando no lo hay —una celda de
 * tabla muy angosta— el `title` y el texto para lectores lo cubren.
 */
export function PuntoEstado({ estado, texto }: PropsIndicador) {
  const etiqueta = texto ?? ETIQUETA_ESTADO[estado]
  const formas: Record<EstadoGeneral, string> = {
    saludable: 'rounded-full',
    advertencia: 'rounded-[2px] rotate-45',
    critico: 'rounded-[1px]',
    'sin-datos': 'rounded-full opacity-50',
  }

  return (
    <span className="inline-flex items-center gap-1.5" title={etiqueta}>
      {/* Forma distinta por estado: círculo, rombo, cuadrado. Se distinguen
          en escala de grises y a tamaño chico. */}
      <span
        aria-hidden
        className={cn('inline-block size-2 shrink-0', formas[estado])}
        style={{ backgroundColor: `var(--color-${claveColor(estado)})` }}
      />
      <span className="solo-lectores">{etiqueta}</span>
    </span>
  )
}

function claveColor(estado: EstadoGeneral): string {
  if (estado === 'saludable') return 'sano'
  if (estado === 'advertencia') return 'aviso'
  if (estado === 'critico') return 'critico'
  return 'neutro'
}

/**
 * Barra de proporción.
 *
 * Se usa para uso de disco y de memoria. Tiene `role="meter"` con sus valores
 * para que un lector de pantalla anuncie el porcentaje: sin eso, la barra es
 * decorativa y el dato sólo existe en el texto de al lado.
 */
export function Barra({
  porcentaje,
  estado,
  etiqueta,
}: {
  porcentaje: number | null
  estado: EstadoGeneral
  etiqueta: string
}) {
  const valor = porcentaje === null ? 0 : Math.min(100, Math.max(0, porcentaje))

  return (
    <div
      role="meter"
      aria-valuenow={porcentaje === null ? undefined : Math.round(valor)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={etiqueta}
      className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
        style={{
          width: `${valor}%`,
          backgroundColor: `var(--color-${claveColor(estado)})`,
        }}
      />
    </div>
  )
}
