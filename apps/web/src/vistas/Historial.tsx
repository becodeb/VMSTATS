import { useEffect, useMemo, useState } from 'react'
import { DownloadIcon } from 'lucide-react'
import type { ClaveSerie, Serie } from '@vmstats/shared'
import {
  SERIES_HISTORIAL,
  formatearBytes,
  formatearNumero,
  formatearPorcentaje,
  formatearTasa,
  periodoAnterior,
} from '@vmstats/shared'
import { Bloque } from '@/componentes/bloques'
import { useMontado } from '@/hooks/useMontado'
import { GraficoSerie } from '@/componentes/GraficoSerie'
import { useHistorial } from '@/hooks/useHistorial'
import { Button } from '@/components/ui/button'
import { Aviso, Campo, Esqueleto, Etiqueta, Rotulo } from '@/components/ui/varios'

/* ============================================================================
 * Historial.
 *
 * Un rango arbitrario, comparado contra el período inmediatamente anterior de
 * la misma duración. La comparación es lo que convierte un número en
 * información: «CPU promedio 34 %» no dice nada; «34 %, contra 19 % la semana
 * pasada» sí.
 * ========================================================================== */

const SERIES_DISPONIBLES: ClaveSerie[] = [
  'cpu.total',
  'memoria.usada',
  'carga.uno',
  'red.rx',
  'red.tx',
  'disco.lectura',
  'disco.escritura',
  'presion.io',
]

/** Últimas 24 horas, redondeadas al minuto para que la URL sea estable. */
function rangoInicial(): { desde: Date; hasta: Date } {
  const hasta = new Date()
  hasta.setSeconds(0, 0)
  return { desde: new Date(hasta.getTime() - 24 * 60 * 60 * 1000), hasta }
}

/** `YYYY-MM-DDTHH:mm` en hora local, que es lo que espera datetime-local. */
function paraInput(fecha: Date): string {
  const desfase = fecha.getTimezoneOffset() * 60_000
  return new Date(fecha.getTime() - desfase).toISOString().slice(0, 16)
}

function promedio(serie: Serie | undefined): number | null {
  if (serie === undefined) return null
  const valores = serie.puntos
    .map((p) => p[1])
    .filter((v): v is number => v !== null && Number.isFinite(v))
  if (valores.length === 0) return null
  return valores.reduce((s, v) => s + v, 0) / valores.length
}

function formatearSegunUnidad(valor: number | null, unidad: string): string {
  if (valor === null) return '—'
  if (unidad === '%') return formatearPorcentaje(valor, 1)
  if (unidad === 'B') return formatearBytes(valor)
  if (unidad === 'B/s') return formatearTasa(valor)
  return formatearNumero(valor)
}

interface Props {
  zonaHoraria: string
}

export function Historial({ zonaHoraria }: Props) {
  /* El rango arranca vacío y se llena al montar.
   *
   * `rangoInicial()` depende del reloj y `paraInput()` del huso local: si se
   * calcularan durante el render del servidor, el HTML traería un rango y el
   * navegador otro, y React descartaría la hidratación. Un enlace a
   * `?view=history` renderiza en el servidor, así que esto no es teórico. */
  const montado = useMontado()
  const [rango, setRango] = useState<{ desde: Date; hasta: Date } | null>(null)

  useEffect(() => {
    setRango(rangoInicial())
  }, [])

  if (!montado || rango === null) {
    return <Esqueleto className="h-96 w-full" />
  }

  return <HistorialInterior zonaHoraria={zonaHoraria} inicial={rango} />
}

function HistorialInterior({
  zonaHoraria,
  inicial,
}: {
  zonaHoraria: string
  inicial: { desde: Date; hasta: Date }
}) {
  const [desde, setDesde] = useState(inicial.desde)
  const [hasta, setHasta] = useState(inicial.hasta)
  const [seleccionadas, setSeleccionadas] = useState<ClaveSerie[]>([
    'cpu.total',
    'memoria.usada',
  ])

  const rangoInvalido = hasta.getTime() <= desde.getTime()
  const anterior = useMemo(() => periodoAnterior(desde, hasta), [desde, hasta])

  const actual = useHistorial({ series: seleccionadas, desde, hasta })
  const previo = useHistorial({
    series: seleccionadas,
    desde: anterior.desde,
    hasta: anterior.hasta,
  })

  const urlCsv = useMemo(() => {
    const url = new URL('/api/exportar', window.location.origin)
    url.searchParams.set('series', seleccionadas.join(','))
    url.searchParams.set('desde', desde.toISOString())
    url.searchParams.set('hasta', hasta.toISOString())
    return url.pathname + url.search
  }, [seleccionadas, desde, hasta])

  function alternarSerie(clave: ClaveSerie): void {
    setSeleccionadas((previas) => {
      if (previas.includes(clave)) {
        // Siempre al menos una: un gráfico sin series no comunica nada.
        return previas.length === 1 ? previas : previas.filter((s) => s !== clave)
      }
      return [...previas, clave]
    })
  }

  return (
    <>
      <Bloque titulo="Rango">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Rotulo htmlFor="desde">Desde</Rotulo>
            <Campo
              id="desde"
              type="datetime-local"
              value={paraInput(desde)}
              max={paraInput(hasta)}
              onChange={(e) => {
                const valor = new Date(e.target.value)
                if (!Number.isNaN(valor.getTime())) setDesde(valor)
              }}
              className="w-auto"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Rotulo htmlFor="hasta">Hasta</Rotulo>
            <Campo
              id="hasta"
              type="datetime-local"
              value={paraInput(hasta)}
              onChange={(e) => {
                const valor = new Date(e.target.value)
                if (!Number.isNaN(valor.getTime())) setHasta(valor)
              }}
              className="w-auto"
            />
          </div>

          <Button
            variante="contorno"
            className="ml-auto"
            disabled={rangoInvalido}
            onClick={() => {
              // Descarga por navegación: el endpoint responde con
              // Content-Disposition y el navegador se encarga.
              window.location.assign(urlCsv)
            }}
          >
            <DownloadIcon aria-hidden />
            Exportar CSV
          </Button>
        </div>

        {rangoInvalido && (
          <Aviso variante="aviso" role="alert">
            El fin del rango tiene que ser posterior al inicio.
          </Aviso>
        )}

        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="text-muted-foreground mb-2 text-xs">Series</legend>
          {SERIES_DISPONIBLES.map((clave) => {
            const activa = seleccionadas.includes(clave)
            return (
              <label
                key={clave}
                className="focus-within:ring-ring cursor-pointer rounded-md focus-within:ring-2"
              >
                <input
                  type="checkbox"
                  checked={activa}
                  onChange={() => alternarSerie(clave)}
                  className="solo-lectores"
                />
                <Etiqueta variante={activa ? 'sana' : 'contorno'}>
                  {SERIES_HISTORIAL[clave].etiqueta}
                </Etiqueta>
              </label>
            )
          })}
        </fieldset>
      </Bloque>

      <Bloque
        titulo="Período consultado"
        nota={
          actual.datos === null
            ? undefined
            : `resolución ${actual.datos.resolucion} · ${actual.datos.bucketSegundos} s por punto`
        }
      >
        {actual.error !== null ? (
          <Aviso variante="critico" role="alert">
            {actual.error}
          </Aviso>
        ) : (
          <GraficoSerie
            titulo="Series del período consultado"
            series={actual.datos?.series ?? []}
            eventos={actual.eventos}
            cargando={actual.cargando}
            zonaHoraria={zonaHoraria}
            altura={260}
          />
        )}
      </Bloque>

      <Bloque
        titulo="Comparación"
        nota="contra el período anterior de la misma duración"
      >
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {seleccionadas.map((clave) => {
            const serieActual = actual.datos?.series.find((s) => s.clave === clave)
            const seriePrevia = previo.datos?.series.find((s) => s.clave === clave)
            const media = promedio(serieActual)
            const mediaPrevia = promedio(seriePrevia)
            const unidad = SERIES_HISTORIAL[clave].unidad

            const variacion =
              media === null || mediaPrevia === null || mediaPrevia === 0
                ? null
                : ((media - mediaPrevia) / mediaPrevia) * 100

            return (
              <div key={clave} className="border-border flex flex-col gap-1 border-l pl-3">
                <span className="text-muted-foreground text-xs">
                  {SERIES_HISTORIAL[clave].etiqueta}
                </span>
                <span className="cifra text-lg font-medium">
                  {formatearSegunUnidad(media, unidad)}
                </span>
                <span className="text-muted-foreground text-xs">
                  antes {formatearSegunUnidad(mediaPrevia, unidad)}
                  {variacion !== null && (
                    <>
                      {' · '}
                      {/* El signo va escrito, no sólo en el color: una flecha
                          verde y una roja son iguales para muchos ojos. */}
                      <span
                        className={
                          Math.abs(variacion) < 1
                            ? undefined
                            : variacion > 0
                              ? 'text-aviso'
                              : 'text-sano'
                        }
                      >
                        {variacion > 0 ? '+' : ''}
                        {formatearNumero(variacion, 1)} %
                      </span>
                    </>
                  )}
                </span>
              </div>
            )
          })}
        </div>

        <GraficoSerie
          titulo="Series del período anterior"
          series={previo.datos?.series ?? []}
          cargando={previo.cargando}
          zonaHoraria={zonaHoraria}
          altura={180}
        />
      </Bloque>

      {actual.eventos.length > 0 && (
        <Bloque titulo="Eventos en el rango" nota={`${actual.eventos.length}`}>
          <ul className="divide-border divide-y">
            {actual.eventos.slice(0, 30).map((evento) => (
              <li key={evento.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <Etiqueta
                  variante={
                    evento.estado === 'failed'
                      ? 'critica'
                      : evento.estado === 'finished'
                        ? 'sana'
                        : 'aviso'
                  }
                >
                  {evento.estado}
                </Etiqueta>
                <span className="text-sm">{evento.aplicacionNombre ?? 'sin nombre'}</span>
                {evento.rama !== null && (
                  <span className="text-muted-foreground text-xs">{evento.rama}</span>
                )}
                <span className="text-muted-foreground cifra ml-auto text-xs">
                  {new Date(evento.observadoEn).toLocaleString('es-AR', {
                    timeZone: zonaHoraria,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </Bloque>
      )}
    </>
  )
}
