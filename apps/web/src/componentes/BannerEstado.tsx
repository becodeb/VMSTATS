import { CloudOffIcon, PauseIcon, RadioIcon, RefreshCwIcon } from 'lucide-react'
import type { Instantanea } from '@vmstats/shared'
import { formatearFechaHora } from '@vmstats/shared'
import type { EstadoConexion } from '@/hooks/useFlujo'
import { Aviso, AvisoTitulo } from '@/components/ui/varios'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Banner de estado de los datos.
 *
 * Dos problemas distintos que la UI no puede confundir:
 *
 *  - El collector dejó de reportar → los números que se ven son viejos.
 *    Es grave: la consola parecería sana mostrando una foto de hace una hora.
 *  - Se cayó el stream del navegador → el collector puede estar perfecto.
 *    Es leve, y se resuelve solo.
 *
 * El primero se anuncia como alerta; el segundo es una nota discreta.
 * ========================================================================== */

interface Props {
  instantanea: Instantanea | null
  conexion: EstadoConexion
  desactualizado: boolean
  zonaHoraria: string
}

export function BannerEstado({ instantanea, conexion, desactualizado, zonaHoraria }: Props) {
  if (instantanea === null) {
    return (
      <Aviso variante="neutro" role="status">
        <AvisoTitulo>Esperando la primera muestra</AvisoTitulo>
        <span className="text-muted-foreground text-sm">
          El collector todavía no reportó. En el primer arranque tarda un ciclo en tener
          con qué calcular las tasas.
        </span>
      </Aviso>
    )
  }

  if (desactualizado) {
    const ultimo = instantanea.ultimoLatido

    return (
      // `assertive`: alguien mirando la consola tiene que enterarse de que lo
      // que está viendo ya no es el presente.
      <Aviso variante="critico" role="alert" aria-live="assertive">
        <AvisoTitulo className="flex items-center gap-2">
          <CloudOffIcon aria-hidden className="size-4" />
          Datos desactualizados
        </AvisoTitulo>
        <span className="text-muted-foreground text-sm">
          El collector dejó de reportar
          {ultimo === null ? '' : ` (última muestra: ${formatearFechaHora(ultimo, zonaHoraria)})`}.
          Los valores de abajo son los últimos conocidos, no el estado actual.
        </span>
      </Aviso>
    )
  }

  // Todo en orden: una línea discreta, no un cartel.
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <EstadoConexionVisual conexion={conexion} />
      {instantanea.host !== null && (
        <span className="ml-auto">
          Última muestra {formatearFechaHora(instantanea.host.ts, zonaHoraria)}
        </span>
      )}
    </div>
  )
}

function EstadoConexionVisual({ conexion }: { conexion: EstadoConexion }) {
  const config = {
    conectado: { Icono: RadioIcon, texto: 'En vivo', clase: 'text-sano' },
    conectando: { Icono: RefreshCwIcon, texto: 'Conectando', clase: 'text-muted-foreground' },
    reconectando: { Icono: RefreshCwIcon, texto: 'Reconectando', clase: 'text-aviso' },
    polling: { Icono: RefreshCwIcon, texto: 'Actualizando cada 15 s', clase: 'text-aviso' },
    pausado: { Icono: PauseIcon, texto: 'En pausa', clase: 'text-muted-foreground' },
  } as const

  const { Icono, texto, clase } = config[conexion]
  const girando = conexion === 'conectando' || conexion === 'reconectando'

  return (
    <span className={cn('inline-flex items-center gap-1.5', clase)} role="status">
      <Icono
        aria-hidden
        className={cn('size-3', girando && 'animate-spin motion-reduce:animate-none')}
      />
      {texto}
    </span>
  )
}
