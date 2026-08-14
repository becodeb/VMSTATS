import { useMemo, useState } from 'react'
import type { EstadoGeneral, Instantanea, MuestraContenedor } from '@vmstats/shared'
import {
  formatearBytes,
  formatearDuracion,
  formatearFechaHora,
  formatearPorcentaje,
  formatearTasa,
  porcentajeDe,
} from '@vmstats/shared'
import { Bloque, Dato, NoDisponible, Vacio } from '@/componentes/bloques'
import { Desplegable } from '@/componentes/Desplegable'
import { InspectorLateral } from '@/componentes/InspectorLateral'
import { PuntoEstado } from '@/componentes/estado'
import { TablaAdaptable } from '@/componentes/TablaAdaptable'
import { VisorLogs } from '@/componentes/VisorLogs'
import { DEFINICIONES } from '@/components/ui/pista'
import { Etiqueta } from '@/components/ui/varios'

/* ============================================================================
 * Contenedores.
 *
 * Lista compacta con filtros y orden, más un inspector lateral con el detalle
 * y los logs bajo demanda.
 *
 * No hay ningún botón que actúe sobre un contenedor: ni reiniciar, ni parar, ni
 * ejecutar. La spec lo prohíbe y el camino directamente no existe en el código
 * — el cliente de Docker del collector sólo sabe hacer GET.
 * ========================================================================== */

const SIN_CONTENEDORES: readonly MuestraContenedor[] = []

type Orden = 'cpu' | 'memoria' | 'reinicios' | 'nombre'

const ORDENES = [
  { valor: 'cpu', etiqueta: 'CPU' },
  { valor: 'memoria', etiqueta: 'Memoria' },
  { valor: 'reinicios', etiqueta: 'Reinicios' },
  { valor: 'nombre', etiqueta: 'Nombre' },
] as const

/** El estado de salud de un contenedor, traducido al semáforo de la consola. */
function estadoDe(c: MuestraContenedor): EstadoGeneral {
  if (c.estado === 'dead') return 'critico'
  if (c.salud === 'unhealthy') return 'critico'
  if (c.estado === 'restarting') return 'advertencia'
  if (c.estado === 'exited' || c.estado === 'paused') return 'sin-datos'
  if (c.salud === 'starting') return 'advertencia'
  return 'saludable'
}

function textoEstado(c: MuestraContenedor): string {
  if (c.salud === 'unhealthy') return 'Healthcheck fallando'
  if (c.salud === 'starting') return 'Healthcheck iniciando'
  if (c.estado === 'running') return 'En marcha'
  if (c.estado === 'restarting') return 'Reiniciando'
  if (c.estado === 'exited') return 'Detenido'
  if (c.estado === 'paused') return 'En pausa'
  if (c.estado === 'dead') return 'Muerto'
  return c.estado
}

interface Props {
  instantanea: Instantanea | null
  zonaHoraria: string
}

export function Contenedores({ instantanea, zonaHoraria }: Props) {
  const [filtroEstado, setFiltroEstado] = useState('todos')
  const [filtroApp, setFiltroApp] = useState('todas')
  const [orden, setOrden] = useState<Orden>('cpu')
  const [inspeccionado, setInspeccionado] = useState<string | null>(null)

  /* Referencia estable: `?? []` crea un array nuevo en cada render, y los
   * memos que dependen de él se recalculaban siempre. */
  const todos = useMemo(
    () => instantanea?.contenedores ?? SIN_CONTENEDORES,
    [instantanea],
  )
  const hayDocker = instantanea?.host?.capacidades.contenedores ?? false

  const aplicaciones = useMemo(() => {
    const cuenta = new Map<string, number>()
    for (const c of todos) {
      const app = c.coolifyAplicacion ?? 'Sin aplicación'
      cuenta.set(app, (cuenta.get(app) ?? 0) + 1)
    }
    return [...cuenta.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))
  }, [todos])

  const visibles = useMemo(() => {
    const filtrados = todos.filter((c) => {
      if (filtroEstado === 'problemas') {
        const e = estadoDe(c)
        if (e !== 'critico' && e !== 'advertencia') return false
      } else if (filtroEstado === 'corriendo' && c.estado !== 'running') return false
      else if (filtroEstado === 'detenidos' && c.estado === 'running') return false

      if (filtroApp !== 'todas') {
        const app = c.coolifyAplicacion ?? 'Sin aplicación'
        if (app !== filtroApp) return false
      }
      return true
    })

    return filtrados.toSorted((a, b) => {
      if (orden === 'nombre') return a.nombre.localeCompare(b.nombre)
      if (orden === 'memoria') return b.memoriaBytes - a.memoriaBytes
      if (orden === 'reinicios') return b.reinicios - a.reinicios
      return b.cpuPorcentaje - a.cpuPorcentaje
    })
  }, [todos, filtroEstado, filtroApp, orden])

  const detalle = todos.find((c) => c.contenedorId === inspeccionado) ?? null

  if (!hayDocker && todos.length === 0) {
    return (
      <NoDisponible
        que="Contenedores"
        porque="El collector no tiene acceso al Docker Engine. Revisá que el proxy de sólo lectura esté levantado y que DOCKER_PROXY_HOST apunte a él."
      />
    )
  }

  const conProblemas = todos.filter((c) => {
    const e = estadoDe(c)
    return e === 'critico' || e === 'advertencia'
  }).length

  return (
    <>
      <Bloque
        titulo="Contenedores"
        nota={`${visibles.length} de ${todos.length}`}
        acciones={
          <div className="flex flex-wrap items-center gap-2">
            <Desplegable
              etiqueta="Estado"
              valor={filtroEstado}
              onCambiar={setFiltroEstado}
              opciones={[
                { valor: 'todos', etiqueta: 'Todos', contador: todos.length },
                {
                  valor: 'corriendo',
                  etiqueta: 'En marcha',
                  contador: todos.filter((c) => c.estado === 'running').length,
                },
                {
                  valor: 'detenidos',
                  etiqueta: 'Detenidos',
                  contador: todos.filter((c) => c.estado !== 'running').length,
                },
                { valor: 'problemas', etiqueta: 'Con problemas', contador: conProblemas },
              ]}
            />

            <Desplegable
              etiqueta="Aplicación"
              valor={filtroApp}
              onCambiar={setFiltroApp}
              opciones={[
                { valor: 'todas', etiqueta: 'Todas', contador: todos.length },
                ...aplicaciones.map(([nombre, n]) => ({
                  valor: nombre,
                  etiqueta: nombre,
                  contador: n,
                })),
              ]}
            />

            <Desplegable
              etiqueta="Orden"
              valor={orden}
              onCambiar={(v) => setOrden(v as Orden)}
              opciones={ORDENES.map((o) => ({ valor: o.valor, etiqueta: o.etiqueta }))}
            />
          </div>
        }
      >
        <TablaAdaptable
          titulo="Contenedores en ejecución"
          filas={visibles}
          clave={(c) => c.contenedorId}
          onSeleccionar={(c) => setInspeccionado(c.contenedorId)}
          tituloFila={(c) => (
            <span className="flex items-center gap-2">
              <PuntoEstado estado={estadoDe(c)} texto={textoEstado(c)} />
              {c.nombre}
            </span>
          )}
          vacio={
            <Vacio
              titulo="Ningún contenedor coincide"
              detalle="Probá con otro filtro de estado o de aplicación."
            />
          }
          columnas={[
            {
              clave: 'estado',
              etiqueta: 'Estado',
              render: (c) => (
                <span className="flex items-center gap-2">
                  <PuntoEstado estado={estadoDe(c)} texto={textoEstado(c)} />
                  <span className="text-xs">{textoEstado(c)}</span>
                </span>
              ),
            },
            {
              clave: 'nombre',
              etiqueta: 'Nombre',
              prioridad: 'secundaria',
              render: (c) => <span className="font-medium">{c.nombre}</span>,
            },
            {
              clave: 'cpu',
              etiqueta: 'CPU',
              numerica: true,
              render: (c) => formatearPorcentaje(c.cpuPorcentaje, 1),
            },
            {
              clave: 'memoria',
              etiqueta: 'Memoria',
              numerica: true,
              render: (c) =>
                c.memoriaLimiteBytes === null
                  ? formatearBytes(c.memoriaBytes)
                  : `${formatearBytes(c.memoriaBytes)} / ${formatearBytes(c.memoriaLimiteBytes)}`,
            },
            {
              clave: 'red',
              etiqueta: 'Red',
              numerica: true,
              prioridad: 'secundaria',
              render: (c) =>
                `↓ ${formatearTasa(c.redRxBytesPorSeg)} ↑ ${formatearTasa(c.redTxBytesPorSeg)}`,
            },
            {
              clave: 'uptime',
              etiqueta: 'Uptime',
              numerica: true,
              prioridad: 'secundaria',
              render: (c) => (c.estado === 'running' ? formatearDuracion(c.uptimeSegundos) : '—'),
            },
            {
              clave: 'reinicios',
              etiqueta: 'Reinicios',
              numerica: true,
              prioridad: 'secundaria',
              render: (c) =>
                c.reinicios === 0 ? (
                  '0'
                ) : (
                  <span className={c.reinicios > 3 ? 'text-critico' : undefined}>
                    {c.reinicios}
                  </span>
                ),
            },
            {
              clave: 'app',
              etiqueta: 'Aplicación',
              prioridad: 'secundaria',
              render: (c) => c.coolifyAplicacion ?? '—',
            },
          ]}
        />
      </Bloque>

      <InspectorLateral
        abierto={detalle !== null}
        titulo={detalle?.nombre ?? ''}
        subtitulo={detalle?.imagen}
        onCerrar={() => setInspeccionado(null)}
      >
        {detalle !== null && (
          <DetalleContenedor contenedor={detalle} zonaHoraria={zonaHoraria} />
        )}
      </InspectorLateral>
    </>
  )
}

function DetalleContenedor({
  contenedor,
  zonaHoraria,
}: {
  contenedor: MuestraContenedor
  zonaHoraria: string
}) {
  const memoriaPct =
    contenedor.memoriaLimiteBytes === null
      ? null
      : porcentajeDe(contenedor.memoriaBytes, contenedor.memoriaLimiteBytes)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Etiqueta
          variante={
            estadoDe(contenedor) === 'critico'
              ? 'critica'
              : estadoDe(contenedor) === 'advertencia'
                ? 'aviso'
                : 'sana'
          }
        >
          {textoEstado(contenedor)}
        </Etiqueta>
        {contenedor.salud !== 'none' && (
          <Etiqueta variante="contorno">healthcheck: {contenedor.salud}</Etiqueta>
        )}
        {contenedor.coolifyAplicacion !== null && (
          <Etiqueta variante="neutra">{contenedor.coolifyAplicacion}</Etiqueta>
        )}
      </div>

      <section className="flex flex-col gap-1" aria-label="Métricas">
        <h3 className="text-muted-foreground mb-1 text-xs font-medium">Métricas</h3>
        <Dato etiqueta="CPU" valor={formatearPorcentaje(contenedor.cpuPorcentaje, 1)} />
        <Dato
          etiqueta="Memoria"
          valor={
            contenedor.memoriaLimiteBytes === null
              ? `${formatearBytes(contenedor.memoriaBytes)} (sin límite)`
              : `${formatearBytes(contenedor.memoriaBytes)} de ${formatearBytes(
                  contenedor.memoriaLimiteBytes,
                )} · ${formatearPorcentaje(memoriaPct, 0)}`
          }
        />
        <Dato etiqueta="Red entrante" valor={formatearTasa(contenedor.redRxBytesPorSeg)} />
        <Dato etiqueta="Red saliente" valor={formatearTasa(contenedor.redTxBytesPorSeg)} />
        <Dato
          etiqueta="Lectura de bloque"
          valor={formatearTasa(contenedor.bloqueLecturaBytesPorSeg)}
        />
        <Dato
          etiqueta="Escritura de bloque"
          valor={formatearTasa(contenedor.bloqueEscrituraBytesPorSeg)}
        />
      </section>

      <section className="flex flex-col gap-1" aria-label="Metadatos">
        <h3 className="text-muted-foreground mb-1 text-xs font-medium">Metadatos</h3>
        <Dato
          etiqueta="Uptime"
          valor={
            contenedor.estado === 'running'
              ? formatearDuracion(contenedor.uptimeSegundos)
              : 'no está corriendo'
          }
          explicacion={DEFINICIONES.uptime}
        />
        <Dato
          etiqueta="Reinicios"
          valor={String(contenedor.reinicios)}
          explicacion={DEFINICIONES.reinicios}
        />
        <Dato
          etiqueta="Imagen"
          valor={<span className="font-mono text-xs break-all">{contenedor.imagen}</span>}
        />
        <Dato
          etiqueta="Id"
          valor={
            <span className="font-mono text-xs">{contenedor.contenedorId.slice(0, 12)}</span>
          }
        />
        <Dato
          etiqueta="Última muestra"
          valor={formatearFechaHora(contenedor.ts, zonaHoraria)}
        />
      </section>

      <section aria-label="Puertos">
        <h3 className="text-muted-foreground mb-1 text-xs font-medium">Puertos publicados</h3>
        {contenedor.puertos.length === 0 ? (
          <p className="text-muted-foreground text-sm">Ninguno.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {contenedor.puertos.map((p, i) => (
              <li key={`${p.privado}-${p.protocolo}-${i}`}>
                <Etiqueta variante="contorno" className="font-mono">
                  {p.publico === null
                    ? `${p.privado}/${p.protocolo}`
                    : `${p.ip ?? '0.0.0.0'}:${p.publico} → ${p.privado}/${p.protocolo}`}
                </Etiqueta>
              </li>
            ))}
          </ul>
        )}
      </section>

      <VisorLogs contenedorId={contenedor.contenedorId} zonaHoraria={zonaHoraria} />
    </div>
  )
}
