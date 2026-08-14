import { useId, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { EventoDespliegue, Serie } from '@vmstats/shared'
import {
  formatearBytes,
  formatearFechaHora,
  formatearHora,
  formatearNumero,
  formatearPorcentaje,
  formatearTasa,
} from '@vmstats/shared'
import { Esqueleto } from '@/components/ui/varios'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Gráfico de series temporales.
 *
 * Tres cosas que este componente hace y que un gráfico por defecto no hace:
 *
 * 1. Los huecos se dibujan como huecos. `connectNulls` queda en false a
 *    propósito: si el collector estuvo caído dos horas, la línea se corta. Un
 *    trazo recto uniendo los extremos afirmaría que el sistema estuvo
 *    funcionando en el medio.
 *
 * 2. Tiene alternativa textual. Un `<table>` para lectores de pantalla con las
 *    muestras, más un resumen en prosa con mínimo, máximo y último valor. La
 *    tabla también se puede mostrar en pantalla con un botón.
 *
 * 3. Se simplifica en móvil: menos marcas en los ejes y sin grilla. La spec
 *    pide que los gráficos se simplifiquen en pantalla angosta, no que se
 *    achiquen con todo adentro.
 * ========================================================================== */

const COLORES = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

/* Referencia estable: un `[]` como valor por defecto se recrea en cada
 * render y rompe la igualdad referencial de los memos que dependen de él. */
const SIN_EVENTOS: readonly EventoDespliegue[] = []

/** Trazos distintos además del color: en escala de grises igual se distinguen. */
const PATRONES = ['0', '5 3', '2 3', '8 3 2 3', '1 3']

/* Acceso por índice con valor de respaldo.
 *
 * `noUncheckedIndexedAccess` hace que un índice de array sea `T | undefined`, y
 * Recharts no acepta `undefined` en `stroke` ni en `strokeDasharray`. El módulo
 * es siempre válido, pero el compilador no puede saberlo. */
function color(i: number): string {
  return COLORES[i % COLORES.length] ?? 'var(--color-chart-1)'
}

function patron(i: number): string {
  return PATRONES[i % PATRONES.length] ?? '0'
}

function formatearValor(valor: number | null, unidad: string): string {
  if (valor === null) return '—'
  if (unidad === '%') return formatearPorcentaje(valor, 1)
  if (unidad === 'B') return formatearBytes(valor)
  if (unidad === 'B/s') return formatearTasa(valor)
  return formatearNumero(valor)
}

function formatearEje(valor: number, unidad: string): string {
  if (unidad === '%') return `${Math.round(valor)}`
  if (unidad === 'B' || unidad === 'B/s') return formatearBytes(valor, 0)
  // Un decimal cuando el rango es chico: en un load average que va de 0 a 3,
  // redondear a entero produce dos marcas seguidas que dicen «1».
  return formatearNumero(valor, Math.abs(valor) < 10 ? 1 : 0)
}

interface Props {
  titulo: string
  series: readonly Serie[]
  cargando: boolean
  zonaHoraria: string
  /** Despliegues a superponer como líneas verticales. */
  eventos?: readonly EventoDespliegue[]
  /** Fija el eje Y a 0-100. Para porcentajes: sin esto, una CPU que nunca pasa
   *  del 8 % se dibuja como si estuviera saturada. */
  ejeFijoPorcentaje?: boolean
  altura?: number
}

export function GraficoSerie({
  titulo,
  series,
  cargando,
  zonaHoraria,
  eventos = SIN_EVENTOS,
  ejeFijoPorcentaje = false,
  altura = 200,
}: Props) {
  const idTabla = useId()
  const [tablaVisible, setTablaVisible] = useState(false)

  const { filas, unidad, resumen } = useMemo(() => {
    const unidadSerie = series[0]?.unidad ?? ''
    const largo = series[0]?.puntos.length ?? 0

    const construidas: Record<string, number | null>[] = []
    for (let i = 0; i < largo; i += 1) {
      const fila: Record<string, number | null> = { ts: series[0]?.puntos[i]?.[0] ?? 0 }
      for (const serie of series) fila[serie.clave] = serie.puntos[i]?.[1] ?? null
      construidas.push(fila)
    }

    const resumenes = series.map((serie) => {
      const valores = serie.puntos
        .map((p) => p[1])
        .filter((v): v is number => v !== null && Number.isFinite(v))

      if (valores.length === 0) return `${serie.etiqueta}: sin datos.`

      const min = Math.min(...valores)
      const max = Math.max(...valores)
      const ultimo = valores[valores.length - 1] ?? null
      return `${serie.etiqueta}: mínimo ${formatearValor(min, serie.unidad)}, máximo ${formatearValor(
        max,
        serie.unidad,
      )}, último ${formatearValor(ultimo, serie.unidad)}.`
    })

    return { filas: construidas, unidad: unidadSerie, resumen: resumenes.join(' ') }
  }, [series])

  if (cargando) return <Esqueleto style={{ height: altura }} className="w-full" />

  if (filas.length === 0) {
    return (
      <div
        className="border-border text-muted-foreground flex items-center justify-center rounded-lg border border-dashed text-sm"
        style={{ height: altura }}
      >
        Sin muestras en este rango.
      </div>
    )
  }

  // Sólo transiciones que arrancan o terminan un despliegue: marcar las cinco
  // transiciones de un mismo deploy llenaría el gráfico de líneas.
  const marcas = eventos.filter(
    (e) => e.estado === 'in_progress' || e.estado === 'failed' || e.estado === 'finished',
  )

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="solo-lectores">
        {titulo}. {resumen}
      </figcaption>

      <div style={{ height: altura }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={filas} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid
              stroke="var(--color-border)"
              strokeDasharray="3 6"
              vertical={false}
            />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={(v: number) => formatearHora(new Date(v), zonaHoraria)}
              stroke="var(--color-muted-foreground)"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
              minTickGap={48}
            />
            <YAxis
              stroke="var(--color-muted-foreground)"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={48}
              domain={ejeFijoPorcentaje ? [0, 100] : ['auto', 'auto']}
              tickFormatter={(v: number) => formatearEje(v, unidad)}
            />

            {marcas.map((evento) => (
              <ReferenceLine
                key={evento.id}
                x={Date.parse(evento.observadoEn)}
                stroke={
                  evento.estado === 'failed'
                    ? 'var(--color-critico)'
                    : 'var(--color-muted-foreground)'
                }
                strokeDasharray="2 3"
                strokeWidth={1}
              />
            ))}

            <Tooltip
              content={<Contenido zonaHoraria={zonaHoraria} series={series} />}
              cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
            />

            {series.map((serie, i) => (
              <Line
                key={serie.clave}
                type="monotone"
                dataKey={serie.clave}
                name={serie.etiqueta}
                stroke={color(i)}
                strokeDasharray={patron(i)}
                strokeWidth={1.6}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Leyenda propia: la de Recharts no es navegable con teclado. */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {series.map((serie, i) => (
          <span key={serie.clave} className="inline-flex items-center gap-1.5">
            <svg aria-hidden width="16" height="6" className="shrink-0">
              <line
                x1="0" y1="3" x2="16" y2="3"
                stroke={color(i)}
                strokeWidth="2"
                strokeDasharray={patron(i)}
              />
            </svg>
            {serie.etiqueta}
          </span>
        ))}

        {marcas.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <svg aria-hidden width="16" height="6" className="shrink-0">
              <line x1="8" y1="0" x2="8" y2="6" stroke="var(--color-muted-foreground)" strokeWidth="1" strokeDasharray="2 2" />
            </svg>
            Despliegue
          </span>
        )}

        <Button
          tamanio="sm"
          variante="fantasma"
          className="ml-auto h-6 px-2 text-xs"
          aria-expanded={tablaVisible}
          aria-controls={idTabla}
          onClick={() => setTablaVisible((v) => !v)}
        >
          {tablaVisible ? 'Ocultar tabla' : 'Ver como tabla'}
        </Button>
      </div>

      {/* Siempre en el DOM para lectores de pantalla; visible bajo demanda. */}
      <div
        id={idTabla}
        className={cn(tablaVisible ? 'max-h-64 overflow-y-auto' : 'solo-lectores')}
      >
        <table className="w-full text-left text-xs">
          <caption className="solo-lectores">{titulo}, valores por momento</caption>
          <thead className="text-muted-foreground sticky top-0 bg-card">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Momento</th>
              {series.map((s) => (
                <th key={s.clave} scope="col" className="py-1 pr-3 font-medium">
                  {s.etiqueta}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {filas.map((fila) => (
              <tr key={fila['ts']}>
                <td className="cifra py-1 pr-3 whitespace-nowrap">
                  {formatearFechaHora(new Date(fila['ts'] ?? 0), zonaHoraria)}
                </td>
                {series.map((s) => (
                  <td key={s.clave} className="cifra py-1 pr-3 whitespace-nowrap">
                    {formatearValor(fila[s.clave] ?? null, s.unidad)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}

interface PropsContenido {
  active?: boolean
  label?: string | number
  payload?: readonly { dataKey?: string | number; value?: number | null }[]
  zonaHoraria: string
  series: readonly Serie[]
}

function Contenido({ active, label, payload, zonaHoraria, series }: PropsContenido) {
  if (active !== true || payload === undefined || payload.length === 0) return null

  return (
    <div className="bg-popover border-border rounded-md border px-3 py-2 text-xs shadow-none">
      <p className="text-muted-foreground mb-1">
        {formatearFechaHora(new Date(Number(label ?? 0)), zonaHoraria)}
      </p>
      {payload.map((entrada) => {
        const serie = series.find((s) => s.clave === entrada.dataKey)
        if (serie === undefined) return null
        return (
          <p key={serie.clave} className="flex items-baseline justify-between gap-4">
            <span>{serie.etiqueta}</span>
            <span className="cifra font-medium">
              {formatearValor(entrada.value ?? null, serie.unidad)}
            </span>
          </p>
        )
      })}
    </div>
  )
}
