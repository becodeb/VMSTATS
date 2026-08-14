import { useMemo, useState } from 'react'
import { LogOutIcon, SettingsIcon } from 'lucide-react'
import type { Instantanea } from '@vmstats/shared'
import { Button } from '@/components/ui/button'
import { BotonTema } from '@/componentes/BotonTema'
import { FranjaDespliegue } from '@/componentes/FranjaDespliegue'
import { usePulso } from '@/componentes/LineaPulso'
import { NavegacionLiquida, type Pestania } from '@/componentes/NavegacionLiquida'
import { Preferencias } from '@/componentes/Preferencias'
import { BannerEstado } from '@/componentes/BannerEstado'
import { ProveedorTema } from '@/tema/tema'
import { useFlujo } from '@/hooks/useFlujo'
import { useVista } from '@/hooks/useVista'
import { Alertas } from '@/vistas/Alertas'
import { Contenedores } from '@/vistas/Contenedores'
import { Despliegues } from '@/vistas/Despliegues'
import { Historial } from '@/vistas/Historial'
import { Recursos } from '@/vistas/Recursos'
import { Resumen } from '@/vistas/Resumen'

/* ============================================================================
 * La consola.
 *
 * Raíz de React del dashboard. Tiene una sola responsabilidad de estado: la
 * conexión en vivo. Todo lo demás (rangos, filtros, orden, inspector) vive en
 * la vista que lo usa, para que cambiar de sección no arrastre el estado de la
 * anterior.
 *
 * La cabecera conserva la anatomía de Panky: sticky, `bg-background/85`,
 * blur, borde inferior, ancho máximo de 100rem, marca y subtítulo a la
 * izquierda, navegación líquida centrada en desktop y controles a la derecha.
 * En pantalla angosta la navegación baja a su propia fila en vez de comprimir
 * el resto.
 * ========================================================================== */

export const VISTAS = [
  'overview',
  'resources',
  'containers',
  'deployments',
  'alerts',
  'history',
] as const

export type Vista = (typeof VISTAS)[number]

const ETIQUETAS: Record<Vista, string> = {
  overview: 'Resumen',
  resources: 'Recursos',
  containers: 'Contenedores',
  deployments: 'Despliegues',
  alerts: 'Alertas',
  history: 'Historial',
}

interface Props {
  email: string
  zonaHoraria: string
  instantaneaInicial: Instantanea | null
  csrf: string
  /** La sección que el servidor leyó de `?view=`. */
  vistaInicial: Vista
}

export function Consola(props: Props) {
  return (
    <ProveedorTema>
      <Interior {...props} />
    </ProveedorTema>
  )
}

function Interior({ email, zonaHoraria: zonaInicial, instantaneaInicial, csrf, vistaInicial }: Props) {
  const [zonaHoraria, setZonaHoraria] = useState(zonaInicial)
  const [preferenciasAbiertas, setPreferenciasAbiertas] = useState(false)
  const { instantanea, conexion, desactualizado } = useFlujo(instantaneaInicial)
  const [vista, setVista] = useVista<Vista>(VISTAS, 'overview', vistaInicial)
  const pulso = usePulso(instantanea)

  const alertasAbiertas = instantanea?.alertasAbiertas.length ?? 0
  const desplieguesActivos = instantanea?.desplieguesActivos ?? []

  const pestanias = useMemo<Pestania[]>(
    () =>
      VISTAS.map((id) => ({
        id,
        etiqueta: ETIQUETAS[id],
        // El contador va sólo en Alertas: es lo único que exige mirar ahora.
        ...(id === 'alerts' && alertasAbiertas > 0 ? { contador: alertasAbiertas } : {}),
      })),
    [alertasAbiertas],
  )

  async function salir(): Promise<void> {
    await fetch('/api/sesion', {
      method: 'DELETE',
      headers: { 'x-vmstats-csrf': csrf },
    })
    window.location.assign('/login')
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-background/85 sticky top-0 z-20 border-b backdrop-blur">
        {/* `auto` en la columna del medio: con 1fr las seis pestañas se
            comprimen y la última cae a otra fila antes de tiempo. */}
        <div className="mx-auto grid w-full max-w-[100rem] grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:px-6 xl:grid-cols-[1fr_auto_1fr]">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="text-lg font-semibold tracking-tight">vmstats</span>
            <span className="text-muted-foreground hidden truncate text-sm sm:inline">
              Estado de la infraestructura
            </span>
          </div>

          <div className="order-last col-span-2 flex justify-center xl:order-none xl:col-span-1">
            <NavegacionLiquida
              pestanias={pestanias}
              activa={vista}
              onCambiar={(id) => setVista(id as Vista)}
            />
          </div>

          <div className="flex min-w-0 items-center justify-end gap-2">
            <span className="text-muted-foreground hidden max-w-[22ch] truncate text-sm 2xl:inline">
              {email}
            </span>
            <BotonTema />
            <Button
              variante="fantasma"
              tamanio="icono"
              onClick={() => setPreferenciasAbiertas(true)}
              aria-label="Preferencias"
              title="Preferencias"
            >
              <SettingsIcon aria-hidden />
            </Button>
            <Button variante="contorno" tamanio="sm" onClick={() => void salir()}>
              <LogOutIcon aria-hidden />
              <span className="hidden sm:inline">Salir</span>
              <span className="sm:hidden solo-lectores">Salir</span>
            </Button>
          </div>
        </div>

        {/* Franja de despliegue activo, pegada bajo la navbar. Sólo existe
            cuando hay algo desplegándose. */}
        <FranjaDespliegue despliegues={desplieguesActivos} zonaHoraria={zonaHoraria} />
      </header>

      <main
        id="contenido"
        className="mx-auto flex w-full max-w-[100rem] flex-1 flex-col gap-6 px-4 py-6 sm:px-6"
      >
        <BannerEstado
          instantanea={instantanea}
          conexion={conexion}
          desactualizado={desactualizado}
          zonaHoraria={zonaHoraria}
        />

        <div
          role="tabpanel"
          id={`panel-${vista}`}
          aria-labelledby={`pestania-${vista}`}
          tabIndex={-1}
          className="flex flex-col gap-6 outline-none"
        >
          {vista === 'overview' && (
            <Resumen
              instantanea={instantanea}
              pulso={pulso}
              desactualizado={desactualizado}
              zonaHoraria={zonaHoraria}
              onIrA={setVista}
            />
          )}
          {vista === 'resources' && (
            <Recursos instantanea={instantanea} zonaHoraria={zonaHoraria} />
          )}
          {vista === 'containers' && (
            <Contenedores instantanea={instantanea} zonaHoraria={zonaHoraria} />
          )}
          {vista === 'deployments' && <Despliegues zonaHoraria={zonaHoraria} />}
          {vista === 'alerts' && <Alertas csrf={csrf} zonaHoraria={zonaHoraria} />}
          {vista === 'history' && <Historial zonaHoraria={zonaHoraria} />}
        </div>
      </main>

      {preferenciasAbiertas && (
        <Preferencias
          csrf={csrf}
          onCerrar={() => setPreferenciasAbiertas(false)}
          onGuardado={setZonaHoraria}
        />
      )}

      <footer className="text-muted-foreground mx-auto w-full max-w-[100rem] px-4 pt-2 pb-8 text-xs sm:px-6">
        {instantanea?.host !== null && instantanea?.host !== undefined && (
          <span>
            {instantanea.host.sistema.hostname} · {instantanea.host.sistema.distribucion} ·
            kernel {instantanea.host.sistema.kernel} · {instantanea.host.sistema.nucleos} núcleos
          </span>
        )}
      </footer>
    </div>
  )
}
