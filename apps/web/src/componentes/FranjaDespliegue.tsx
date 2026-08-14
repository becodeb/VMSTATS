import { GitBranchIcon } from 'lucide-react'
import type { Despliegue } from '@vmstats/shared'
import { commitCorto, formatearDuracion } from '@vmstats/shared'
import { useMontado } from '@/hooks/useMontado'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Franja de despliegue activo.
 *
 * Vive pegada bajo la navbar mientras haya algo desplegándose y desaparece
 * cuando termina.
 *
 * Lo que NO hace, y es la decisión importante: no muestra un porcentaje. La API
 * de Coolify no publica progreso, así que cualquier número sería inventado —
 * y en una franja que mira alguien esperando un deploy, un 70 % falso es peor
 * que no decir nada. Lo que se muestra es la fase real informada («en cola»,
 * «desplegando») y el tiempo transcurrido, que sí son datos.
 *
 * La barra indeterminada comunica «esto sigue vivo» sin afirmar cuánto falta.
 * ========================================================================== */

interface Props {
  despliegues: readonly Despliegue[]
  zonaHoraria: string
}

const FASE: Record<string, string> = {
  queued: 'En cola',
  in_progress: 'Desplegando',
}

export function FranjaDespliegue({ despliegues }: Props) {
  if (despliegues.length === 0) return null

  return (
    <div
      className="border-border bg-muted/40 border-t"
      // `polite` y no `assertive`: es información de fondo. Interrumpir la
      // lectura de otra cosa por un deploy que arrancó sería invasivo.
      aria-live="polite"
      aria-label="Despliegues en curso"
    >
      <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-1.5 px-4 py-2 sm:px-6">
        {despliegues.slice(0, 3).map((d) => (
          <FilaDespliegue key={d.uuid} despliegue={d} />
        ))}
        {despliegues.length > 3 && (
          <span className="text-muted-foreground text-xs">
            y {despliegues.length - 3} más en curso
          </span>
        )}
      </div>
    </div>
  )
}

function FilaDespliegue({ despliegue }: { despliegue: Despliegue }) {
  // El tiempo transcurrido depende del reloj: se calcula recién en el cliente
  // para que el servidor y la hidratación no rendericen textos distintos.
  const montado = useMontado()

  const transcurrido =
    !montado || despliegue.iniciadoEn === null
      ? null
      : Math.max(0, (Date.now() - Date.parse(despliegue.iniciadoEn)) / 1000)

  const enCurso = despliegue.estado === 'in_progress'

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {/* Barra indeterminada: sin porcentaje, sólo actividad. */}
      <span
        aria-hidden
        className={cn(
          'relative h-1 w-16 shrink-0 overflow-hidden rounded-full',
          enCurso ? 'bg-primary/20' : 'bg-muted-foreground/20',
        )}
      >
        {enCurso && (
          <span className="bg-primary absolute inset-y-0 left-0 w-1/3 animate-[indeterminado_1.4s_ease-in-out_infinite] rounded-full motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-60" />
        )}
      </span>

      <span className="font-medium">{FASE[despliegue.estado] ?? 'Estado desconocido'}</span>

      <span className="truncate font-medium">
        {despliegue.aplicacionNombre ?? 'aplicación sin nombre'}
      </span>

      {despliegue.rama !== null && (
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <GitBranchIcon aria-hidden className="size-3" />
          {despliegue.rama}
        </span>
      )}

      {despliegue.commit !== null && (
        <code className="text-muted-foreground font-mono">{commitCorto(despliegue.commit)}</code>
      )}

      {despliegue.commitMensaje !== null && (
        <span className="text-muted-foreground hidden min-w-0 flex-1 truncate md:inline">
          {despliegue.commitMensaje}
        </span>
      )}

      {transcurrido !== null && (
        <span className="cifra text-muted-foreground ml-auto shrink-0">
          {formatearDuracion(transcurrido)}
        </span>
      )}
    </div>
  )
}
