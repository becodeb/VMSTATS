import { useCallback, useEffect, useState } from 'react'
import { ExternalLinkIcon, GitBranchIcon, RefreshCwIcon } from 'lucide-react'
import { z } from 'zod'
import type { Despliegue, EstadoDespliegue, EventoDespliegue } from '@vmstats/shared'
import {
  commitCorto,
  esquemaDespliegue,
  esquemaEventoDespliegue,
  formatearDuracion,
  formatearFechaHora,
} from '@vmstats/shared'
import { Bloque, Vacio } from '@/componentes/bloques'
import { PuntoEstado } from '@/componentes/estado'
import { InspectorLateral } from '@/componentes/InspectorLateral'
import { TablaAdaptable } from '@/componentes/TablaAdaptable'
import { Button } from '@/components/ui/button'
import { Aviso, Esqueleto, Etiqueta } from '@/components/ui/varios'

/* ============================================================================
 * Despliegues.
 *
 * Lo que se muestra sale de las transiciones que registró el collector, no de
 * una consulta en vivo a Coolify: así el historial sobrevive a que Coolify
 * purgue su cola, y la vista sigue funcionando con Coolify caído.
 * ========================================================================== */

const esquemaRespuesta = z.object({
  activos: z.array(esquemaDespliegue),
  recientes: z.array(esquemaDespliegue),
  eventos: z.array(esquemaEventoDespliegue),
})

const ETIQUETA_ESTADO: Record<EstadoDespliegue, string> = {
  queued: 'En cola',
  in_progress: 'Desplegando',
  finished: 'Terminado',
  failed: 'Falló',
  cancelled: 'Cancelado',
  unknown: 'Desconocido',
}

function estadoVisual(estado: EstadoDespliegue) {
  if (estado === 'failed') return 'critico' as const
  if (estado === 'finished') return 'saludable' as const
  if (estado === 'in_progress' || estado === 'queued') return 'advertencia' as const
  return 'sin-datos' as const
}

interface Props {
  zonaHoraria: string
}

export function Despliegues({ zonaHoraria }: Props) {
  const [datos, setDatos] = useState<z.infer<typeof esquemaRespuesta> | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inspeccionado, setInspeccionado] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const respuesta = await fetch('/api/despliegues?limite=50')
      if (!respuesta.ok) {
        setError('No se pudieron cargar los despliegues.')
        return
      }
      const validado = esquemaRespuesta.safeParse(await respuesta.json())
      if (!validado.success) {
        setError('El servidor devolvió datos con una forma inesperada.')
        return
      }
      setDatos(validado.data)
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  if (cargando && datos === null) {
    return (
      <div className="flex flex-col gap-4">
        <Esqueleto className="h-24 w-full" />
        <Esqueleto className="h-64 w-full" />
      </div>
    )
  }

  if (error !== null && datos === null) {
    return (
      <Aviso variante="critico" role="alert">
        <p className="mb-2">{error}</p>
        <Button tamanio="sm" variante="contorno" onClick={() => void cargar()}>
          <RefreshCwIcon aria-hidden /> Reintentar
        </Button>
      </Aviso>
    )
  }

  const activos = datos?.activos ?? []
  const recientes = datos?.recientes ?? []
  const eventos = datos?.eventos ?? []

  const todos = [...activos, ...recientes]
  const detalle = todos.find((d) => d.uuid === inspeccionado) ?? null
  const eventosDelDetalle = eventos.filter((e) => e.despliegueUuid === inspeccionado)

  if (todos.length === 0) {
    return (
      <Vacio
        titulo="Todavía no se registró ningún despliegue"
        detalle="Si Coolify está configurado, el primer despliegue va a aparecer acá en cuanto arranque. Si no lo está, faltan COOLIFY_BASE_URL y COOLIFY_API_TOKEN en el collector."
      />
    )
  }

  return (
    <>
      {activos.length > 0 && (
        <Bloque titulo="En curso" nota={`${activos.length} activo${activos.length > 1 ? 's' : ''}`}>
          <ul className="divide-border divide-y">
            {activos.map((d) => (
              <li key={d.uuid} className="py-3">
                <FilaResumen
                  despliegue={d}
                  zonaHoraria={zonaHoraria}
                  onAbrir={() => setInspeccionado(d.uuid)}
                />
              </li>
            ))}
          </ul>
        </Bloque>
      )}

      <Bloque
        titulo="Historial"
        nota={`${recientes.length} despliegues`}
        acciones={
          <Button tamanio="sm" variante="fantasma" onClick={() => void cargar()}>
            <RefreshCwIcon aria-hidden /> Actualizar
          </Button>
        }
      >
        <TablaAdaptable
          titulo="Historial de despliegues"
          filas={recientes}
          clave={(d) => d.uuid}
          onSeleccionar={(d) => setInspeccionado(d.uuid)}
          tituloFila={(d) => (
            <span className="flex items-center gap-2">
              <PuntoEstado
                estado={estadoVisual(d.estado)}
                texto={ETIQUETA_ESTADO[d.estado]}
              />
              {d.aplicacionNombre ?? 'sin nombre'}
            </span>
          )}
          vacio={<Vacio titulo="Sin despliegues terminados todavía" />}
          columnas={[
            {
              clave: 'estado',
              etiqueta: 'Estado',
              render: (d) => (
                <span className="flex items-center gap-2">
                  <PuntoEstado estado={estadoVisual(d.estado)} texto={ETIQUETA_ESTADO[d.estado]} />
                  <span className="text-xs">{ETIQUETA_ESTADO[d.estado]}</span>
                </span>
              ),
            },
            {
              clave: 'aplicacion',
              etiqueta: 'Aplicación',
              prioridad: 'secundaria',
              render: (d) => <span className="font-medium">{d.aplicacionNombre ?? '—'}</span>,
            },
            {
              clave: 'rama',
              etiqueta: 'Rama',
              render: (d) =>
                d.rama === null ? (
                  '—'
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs">
                    <GitBranchIcon aria-hidden className="size-3" />
                    {d.rama}
                  </span>
                ),
            },
            {
              clave: 'commit',
              etiqueta: 'Commit',
              prioridad: 'secundaria',
              render: (d) => <span className="font-mono text-xs">{commitCorto(d.commit)}</span>,
            },
            {
              clave: 'duracion',
              etiqueta: 'Duración',
              numerica: true,
              render: (d) => formatearDuracion(d.duracionSegundos),
            },
            {
              clave: 'inicio',
              etiqueta: 'Inicio',
              prioridad: 'secundaria',
              render: (d) => formatearFechaHora(d.iniciadoEn, zonaHoraria),
            },
          ]}
        />
      </Bloque>

      <InspectorLateral
        abierto={detalle !== null}
        titulo={detalle?.aplicacionNombre ?? 'Despliegue'}
        subtitulo={detalle === null ? undefined : commitCorto(detalle.commit)}
        onCerrar={() => setInspeccionado(null)}
      >
        {detalle !== null && (
          <DetalleDespliegue
            despliegue={detalle}
            eventos={eventosDelDetalle}
            zonaHoraria={zonaHoraria}
          />
        )}
      </InspectorLateral>
    </>
  )
}

function FilaResumen({
  despliegue,
  zonaHoraria,
  onAbrir,
}: {
  despliegue: Despliegue
  zonaHoraria: string
  onAbrir: () => void
}) {
  return (
    <button
      type="button"
      onClick={onAbrir}
      className="focus-visible:ring-ring flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-sm text-left outline-none focus-visible:ring-2"
    >
      <PuntoEstado
        estado={estadoVisual(despliegue.estado)}
        texto={ETIQUETA_ESTADO[despliegue.estado]}
      />
      <span className="text-sm font-medium">{despliegue.aplicacionNombre ?? 'sin nombre'}</span>
      <Etiqueta variante="aviso">{ETIQUETA_ESTADO[despliegue.estado]}</Etiqueta>
      {despliegue.rama !== null && (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <GitBranchIcon aria-hidden className="size-3" />
          {despliegue.rama}
        </span>
      )}
      <span className="text-muted-foreground ml-auto text-xs">
        desde {formatearFechaHora(despliegue.iniciadoEn, zonaHoraria)}
      </span>
    </button>
  )
}

function DetalleDespliegue({
  despliegue,
  eventos,
  zonaHoraria,
}: {
  despliegue: Despliegue
  eventos: readonly EventoDespliegue[]
  zonaHoraria: string
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Etiqueta
          variante={
            despliegue.estado === 'failed'
              ? 'critica'
              : despliegue.estado === 'finished'
                ? 'sana'
                : 'aviso'
          }
        >
          {ETIQUETA_ESTADO[despliegue.estado]}
        </Etiqueta>
        {despliegue.rama !== null && (
          <Etiqueta variante="contorno">
            <GitBranchIcon aria-hidden className="size-3" />
            {despliegue.rama}
          </Etiqueta>
        )}
        {despliegue.url !== null && (
          <a
            href={despliegue.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-2"
          >
            Ver en Coolify
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
      </div>

      {despliegue.commitMensaje !== null && (
        <blockquote className="border-border text-muted-foreground border-l-2 pl-3 text-sm">
          {despliegue.commitMensaje}
        </blockquote>
      )}

      <section aria-label="Timeline">
        <h3 className="text-muted-foreground mb-2 text-xs font-medium">Timeline</h3>
        {eventos.length === 0 ? (
          <p className="text-muted-foreground text-sm">Sin transiciones registradas.</p>
        ) : (
          <ol className="flex flex-col">
            {eventos
              .toSorted((a, b) => a.observadoEn.localeCompare(b.observadoEn))
              .map((evento, i, todos) => (
                <li key={evento.id} className="flex gap-3">
                  {/* Riel vertical: un punto por transición y una línea que las
                      une, salvo en la última. */}
                  <div className="flex flex-col items-center">
                    <PuntoEstado
                      estado={estadoVisual(evento.estado)}
                      texto={ETIQUETA_ESTADO[evento.estado]}
                    />
                    {i < todos.length - 1 && (
                      <span aria-hidden className="bg-border w-px flex-1" />
                    )}
                  </div>
                  <div className="flex-1 pb-4">
                    <p className="text-sm">{ETIQUETA_ESTADO[evento.estado]}</p>
                    <p className="text-muted-foreground cifra text-xs">
                      {formatearFechaHora(evento.observadoEn, zonaHoraria)}
                    </p>
                  </div>
                </li>
              ))}
          </ol>
        )}
      </section>

      <section className="flex flex-col gap-1" aria-label="Detalle">
        <h3 className="text-muted-foreground mb-1 text-xs font-medium">Detalle</h3>
        <Fila etiqueta="Aplicación" valor={despliegue.aplicacionNombre ?? '—'} />
        <Fila etiqueta="Commit" valor={commitCorto(despliegue.commit)} mono />
        <Fila etiqueta="Inicio" valor={formatearFechaHora(despliegue.iniciadoEn, zonaHoraria)} />
        <Fila etiqueta="Fin" valor={formatearFechaHora(despliegue.finalizadoEn, zonaHoraria)} />
        <Fila etiqueta="Duración" valor={formatearDuracion(despliegue.duracionSegundos)} />
        <Fila etiqueta="UUID" valor={despliegue.uuid} mono />
      </section>

      {/* Los logs de build requieren un token de Coolify con `read:sensitive`,
          y la spec pide que eso venga apagado. Se explica en vez de mostrar un
          botón que falla. */}
      <p className="text-muted-foreground border-border rounded-md border border-dashed px-3 py-2 text-xs">
        Los logs de build de Coolify necesitan un token con permiso{' '}
        <code className="font-mono">read:sensitive</code>. vmstats usa un token de sólo
        lectura por defecto y no los pide. El detalle está en docs/security.md.
      </p>
    </div>
  )
}

function Fila({
  etiqueta,
  valor,
  mono = false,
}: {
  etiqueta: string
  valor: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground text-xs">{etiqueta}</span>
      <span className={mono ? 'font-mono text-xs break-all' : 'cifra text-sm'}>{valor}</span>
    </div>
  )
}
