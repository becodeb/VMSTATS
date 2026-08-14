import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Instantanea } from '@vmstats/shared'
import {
  esquemaRespuestaHistorial,
  formatearPorcentaje,
  formatearTasa,
  porcentajeDe,
} from '@vmstats/shared'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Línea de pulso.
 *
 * El elemento distintivo de la consola: una sola franja donde conviven CPU,
 * memoria y red. La idea es que se pueda mirar de reojo y saber si la máquina
 * está tranquila, y que cuando algo se mueva, se vea *qué* se movió.
 *
 * Decisiones que la mantienen sobria:
 *
 *  - Sin animación de entrada. La línea avanza porque llegó una muestra nueva,
 *    y ése es el único movimiento. Animar cada actualización haría imposible
 *    leer un valor, que es justo lo que la spec pide evitar.
 *  - Tres trazos de grosor distinto en vez de tres colores fuertes. La CPU
 *    manda (1.75 px), la memoria acompaña (1 px, apagada), la red es el detalle.
 *  - Dibujada a mano en SVG y no con Recharts: son tres polilíneas que se
 *    redibujan cada cinco segundos, y el ciclo completo de Recharts para eso
 *    cuesta más que el gráfico.
 *
 * La red se escala contra su propio máximo de la ventana en vez de contra un
 * tope fijo: el tráfico de una VM va de kB/s a MB/s y con eje fijo se ve una
 * línea plana en cero el 90 % del tiempo.
 * ========================================================================== */

/** 120 muestras a 5 s = 10 minutos de historia en la franja. */
const CAPACIDAD = 120

export interface PuntoPulso {
  ts: number
  cpu: number
  memoria: number
  red: number
}

/**
 * Acumula instantáneas en una ventana móvil, sembrada con historia.
 *
 * Sin la siembra, la franja arranca vacía en cada carga y tarda diez minutos en
 * llenarse: quien abre la consola ve una línea de un centímetro pegada al borde
 * derecho y parece que estuviera rota. Se traen los últimos diez minutos de la
 * base una sola vez, y a partir de ahí manda el SSE.
 */
export function usePulso(instantanea: Instantanea | null): PuntoPulso[] {
  const [puntos, setPuntos] = useState<PuntoPulso[]>([])
  const ultimoTs = useRef<string | null>(null)
  const sembrado = useRef(false)

  useEffect(() => {
    if (sembrado.current) return
    sembrado.current = true

    const control = new AbortController()

    void (async () => {
      try {
        const url = new URL('/api/historial', window.location.origin)
        url.searchParams.set('desde', new Date(Date.now() - 10 * 60_000).toISOString())
        url.searchParams.set('hasta', new Date().toISOString())
        url.searchParams.set('series', 'cpu.total,memoria.usada,red.rx,red.tx')

        const respuesta = await fetch(url, { signal: control.signal })
        if (!respuesta.ok) return

        const datos = esquemaRespuestaHistorial.safeParse(await respuesta.json())
        if (!datos.success) return

        const serie = (clave: string) =>
          datos.data.series.find((s) => s.clave === clave)?.puntos ?? []

        const cpu = serie('cpu.total')
        const memoria = serie('memoria.usada')
        const rx = serie('red.rx')
        const tx = serie('red.tx')

        // La memoria histórica viene en bytes y el pulso la quiere en
        // porcentaje; el total sale de la instantánea, que es el único lugar
        // donde está.
        const total = instantanea?.host?.memoria.total ?? 0

        const historicos: PuntoPulso[] = cpu.flatMap((punto, i) => {
          const [ts, valorCpu] = punto
          if (valorCpu === null) return []
          const usada = memoria[i]?.[1] ?? null
          return [{
            ts,
            cpu: valorCpu,
            memoria: total > 0 && usada !== null ? (usada / total) * 100 : 0,
            red: (rx[i]?.[1] ?? 0) + (tx[i]?.[1] ?? 0),
          }]
        })

        if (historicos.length === 0) return

        setPuntos((previos) => {
          // Lo que ya llegó por SSE manda: es más nuevo que la consulta.
          const desde = previos[0]?.ts ?? Number.POSITIVE_INFINITY
          const anteriores = historicos.filter((p) => p.ts < desde)
          return [...anteriores, ...previos].slice(-CAPACIDAD)
        })
      } catch {
        // Sin historia, la franja se llena en vivo. No es un error que
        // merezca molestar a nadie.
      }
    })()

    return () => control.abort()
    // Se corre una sola vez; `instantanea` sólo aporta el total de memoria.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const host = instantanea?.host
    if (host === undefined || host === null) return
    // El mismo evento puede llegar dos veces (reconexión con reanudación); sin
    // este guard la línea dibujaría un escalón donde no hubo cambio.
    if (host.ts === ultimoTs.current) return
    ultimoTs.current = host.ts

    const red = host.red.reduce((s, i) => s + i.rxBytesPorSeg + i.txBytesPorSeg, 0)

    setPuntos((previos) => {
      const siguiente: PuntoPulso = {
        ts: Date.parse(host.ts),
        cpu: host.cpu.total,
        memoria: porcentajeDe(host.memoria.usada, host.memoria.total) ?? 0,
        red,
      }
      const acumulado = [...previos, siguiente]
      return acumulado.length > CAPACIDAD ? acumulado.slice(-CAPACIDAD) : acumulado
    })
  }, [instantanea])

  return puntos
}

const ANCHO = 1000
const ALTO = 100

/** Coordenadas de una polilínea normalizada a la caja del SVG. */
function trazo(valores: readonly number[], maximo: number): string {
  if (valores.length < 2) return ''
  const paso = ANCHO / (CAPACIDAD - 1)
  // La serie se ancla a la derecha: las muestras nuevas entran por el borde
  // derecho y la franja se llena hacia la izquierda a medida que hay historia.
  const desplazamiento = ANCHO - (valores.length - 1) * paso

  return valores
    .map((valor, i) => {
      const x = desplazamiento + i * paso
      const y = ALTO - (maximo <= 0 ? 0 : Math.min(1, valor / maximo)) * ALTO
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

interface Props {
  puntos: readonly PuntoPulso[]
  desactualizado: boolean
  className?: string
}

export function LineaPulso({ puntos, desactualizado, className }: Props) {
  const idTitulo = useId()
  const idTabla = useId()

  const { caminoCpu, caminoMemoria, caminoRed, maximoRed, ultimo } = useMemo(() => {
    const cpu = puntos.map((p) => p.cpu)
    const memoria = puntos.map((p) => p.memoria)
    const red = puntos.map((p) => p.red)
    // Piso de 1 kB/s: sin él, una VM en silencio absoluto normaliza el ruido de
    // fondo a pantalla completa y parece saturada.
    const topeRed = Math.max(1024, ...red)

    return {
      caminoCpu: trazo(cpu, 100),
      caminoMemoria: trazo(memoria, 100),
      caminoRed: trazo(red, topeRed),
      maximoRed: topeRed,
      ultimo: puntos[puntos.length - 1] ?? null,
    }
  }, [puntos])

  const resumen =
    ultimo === null
      ? 'Todavía no hay muestras.'
      : `CPU ${formatearPorcentaje(ultimo.cpu, 0)}, memoria ${formatearPorcentaje(
          ultimo.memoria,
          0,
        )}, red ${formatearTasa(ultimo.red)}. Pico de red en la ventana: ${formatearTasa(maximoRed)}.`

  return (
    <figure className={cn('relative', className)}>
      <figcaption id={idTitulo} className="solo-lectores">
        Pulso de los últimos diez minutos. {resumen}
      </figcaption>

      <svg
        viewBox={`0 0 ${ANCHO} ${ALTO}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={idTitulo}
        aria-describedby={idTabla}
        className={cn(
          'h-16 w-full transition-opacity sm:h-20',
          desactualizado && 'opacity-40 saturate-0',
        )}
      >
        {/* Referencias al 50 % y al 100 %. Dos líneas finas alcanzan para dar
            escala sin convertir la franja en una grilla. */}
        <line x1="0" y1={ALTO / 2} x2={ANCHO} y2={ALTO / 2}
          stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={ALTO} x2={ANCHO} y2={ALTO}
          stroke="var(--color-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

        {caminoRed !== '' && (
          <path d={caminoRed} fill="none" stroke="var(--color-chart-1)" strokeWidth="1"
            strokeOpacity="0.55" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        )}
        {caminoMemoria !== '' && (
          <path d={caminoMemoria} fill="none" stroke="var(--color-muted-foreground)"
            strokeWidth="1" strokeOpacity="0.7" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        )}
        {caminoCpu !== '' && (
          <path d={caminoCpu} fill="none" stroke="var(--color-foreground)" strokeWidth="1.75"
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        )}
      </svg>

      {/* Leyenda: el grosor por sí solo no alcanza para identificar las series. */}
      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <LeyendaPulso color="var(--color-foreground)" grosor={2} etiqueta="CPU"
          valor={ultimo === null ? null : formatearPorcentaje(ultimo.cpu, 0)} />
        <LeyendaPulso color="var(--color-muted-foreground)" grosor={1} etiqueta="Memoria"
          valor={ultimo === null ? null : formatearPorcentaje(ultimo.memoria, 0)} />
        <LeyendaPulso color="var(--color-chart-1)" grosor={1} etiqueta="Red"
          valor={ultimo === null ? null : formatearTasa(ultimo.red)} />
        <span className="ml-auto hidden sm:inline">10 min</span>
      </div>

      {/* Alternativa textual del gráfico: la spec pide que ningún dato viva
          solamente en una forma visual. */}
      <table id={idTabla} className="solo-lectores">
        <caption>Últimas muestras del pulso</caption>
        <thead>
          <tr><th scope="col">Momento</th><th scope="col">CPU</th><th scope="col">Memoria</th><th scope="col">Red</th></tr>
        </thead>
        <tbody>
          {puntos.slice(-10).map((p) => (
            <tr key={p.ts}>
              <td>{new Date(p.ts).toLocaleTimeString('es-AR')}</td>
              <td>{formatearPorcentaje(p.cpu, 0)}</td>
              <td>{formatearPorcentaje(p.memoria, 0)}</td>
              <td>{formatearTasa(p.red)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

function LeyendaPulso({
  color,
  grosor,
  etiqueta,
  valor,
}: {
  color: string
  grosor: number
  etiqueta: string
  valor: string | null
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-block w-4 rounded-full"
        style={{ backgroundColor: color, height: grosor }} />
      {etiqueta}
      {valor !== null && <span className="cifra text-foreground font-medium">{valor}</span>}
    </span>
  )
}
