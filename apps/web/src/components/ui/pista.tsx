import { useId, type ReactNode } from 'react'
import { InfoIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Pista: el tooltip que explica una métrica.
 *
 * Usa la transición `tooltip` de transitions.dev, que ya se activa con
 * `:hover` y con `:focus-visible` del disparador — o sea que funciona con
 * teclado, no sólo con mouse. Ese detalle es requisito de accesibilidad, no un
 * extra.
 *
 * El contenido va además en un nodo `.solo-lectores` asociado por
 * `aria-describedby`: el CSS de `:hover` no existe para un lector de pantalla,
 * así que el texto tiene que estar en el árbol de accesibilidad de todos modos.
 * ========================================================================== */

interface Props {
  /** Qué es la métrica, en una frase. */
  explicacion: ReactNode
  children: ReactNode
  className?: string
}

export function Pista({ explicacion, children, className }: Props) {
  const id = useId()

  return (
    <span className={cn('t-tt-wrap', className)}>
      <button
        type="button"
        className={cn(
          't-tt-trigger text-muted-foreground hover:text-foreground inline-flex items-center gap-1',
          'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          'focus-visible:ring-offset-background cursor-help transition-colors',
        )}
        aria-describedby={id}
      >
        {children}
        <InfoIcon aria-hidden className="size-3 opacity-60" />
        <span className="solo-lectores">Ver definición</span>
      </button>
      <span id={id} role="tooltip" className="t-tt text-xs leading-relaxed">
        {explicacion}
      </span>
    </span>
  )
}

/**
 * Definiciones de las métricas.
 *
 * Están centralizadas porque la misma métrica aparece en varias vistas y tiene
 * que explicarse igual en todas. Cada una dice qué mide, en qué unidad y —lo
 * más útil— cómo interpretarla.
 */
export const DEFINICIONES = {
  cpu: 'Porcentaje del tiempo de CPU que no estuvo ocioso, promediado entre todos los núcleos. Incluye el tiempo esperando disco (iowait).',
  iowait:
    'Porción del tiempo de CPU esperando a que el disco responda. Alto y sostenido significa que el cuello de botella es el almacenamiento, no el procesador.',
  steal:
    'Tiempo que el hipervisor le dio a otras máquinas virtuales en vez de a esta. No se arregla desde adentro: es el proveedor o un vecino ruidoso.',
  carga:
    'Cantidad promedio de procesos esperando para ejecutarse. Dividida por la cantidad de núcleos: por encima de 1 hay más trabajo que capacidad.',
  memoria:
    'Memoria en uso descontando la que el kernel puede recuperar. La cache no cuenta como ocupada porque se libera sola cuando hace falta.',
  swap: 'Memoria volcada a disco. Cualquier uso sostenido de swap significa que la RAM no alcanza, y todo lo que pase por ahí va a ser lento.',
  disco: 'Espacio ocupado del filesystem. Los inodos se llenan por separado: se puede quedar sin inodos con espacio libre de sobra.',
  presion:
    'PSI del kernel: porcentaje del tiempo en que al menos una tarea estuvo demorada esperando el recurso. Detecta saturación antes que el porcentaje de uso.',
  red: 'Bytes por segundo sumando todas las interfaces, sin contar loopback.',
  latenciaIo:
    'Milisegundos promedio por operación de disco. Si sube sin que suba el caudal, el disco está saturado.',
  reinicios:
    'Cuántas veces Docker reinició el contenedor desde que se creó. Un número que sube solo es un contenedor en bucle de fallos.',
  uptime: 'Tiempo desde el último arranque.',
  tcp: 'Conexiones TCP abiertas. Un time-wait alto es normal tras mucho tráfico corto.',
} as const
