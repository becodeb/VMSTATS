import { useCallback, useEffect, useRef, useState } from 'react'
import {
  esquemaEventoDespliegue,
  esquemaRespuestaHistorial,
  type ClaveRango,
  type ClaveSerie,
  type EventoDespliegue,
  type RespuestaHistorial,
} from '@vmstats/shared'
import { z } from 'zod'

/* ============================================================================
 * Carga de series históricas.
 *
 * Un pedido por cambio de rango o de series. El servidor decide la resolución;
 * el cliente sólo dice qué rango quiere. Ver `lib/historial.ts`.
 * ========================================================================== */

const esquemaRespuesta = esquemaRespuestaHistorial.extend({
  eventos: z.array(esquemaEventoDespliegue).default([]),
})

export interface EstadoHistorial {
  datos: RespuestaHistorial | null
  eventos: EventoDespliegue[]
  cargando: boolean
  error: string | null
  recargar: () => void
}

export interface OpcionesHistorial {
  series: readonly ClaveSerie[]
  rango?: ClaveRango
  desde?: Date
  hasta?: Date
}

export function useHistorial(opciones: OpcionesHistorial): EstadoHistorial {
  const [datos, setDatos] = useState<RespuestaHistorial | null>(null)
  const [eventos, setEventos] = useState<EventoDespliegue[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const abortador = useRef<AbortController | null>(null)

  // Las series se comparan por su forma serializada: el array literal del
  // llamador es nuevo en cada render y usarlo como dependencia dispararía un
  // pedido por render.
  const clave = `${opciones.series.join(',')}|${opciones.rango ?? ''}|${
    opciones.desde?.toISOString() ?? ''
  }|${opciones.hasta?.toISOString() ?? ''}|${version}`

  const seriesTexto = opciones.series.join(',')
  const rango = opciones.rango
  const desde = opciones.desde
  const hasta = opciones.hasta

  const cargar = useCallback(async () => {
    // Cambiar de rango rápido dispara varios pedidos; sin abortar el anterior,
    // el que llega último gana aunque sea el más viejo.
    abortador.current?.abort()
    const control = new AbortController()
    abortador.current = control

    setCargando(true)
    setError(null)

    const url = new URL('/api/historial', window.location.origin)
    url.searchParams.set('series', seriesTexto)
    if (rango !== undefined) url.searchParams.set('rango', rango)
    if (desde !== undefined) url.searchParams.set('desde', desde.toISOString())
    if (hasta !== undefined) url.searchParams.set('hasta', hasta.toISOString())

    try {
      const respuesta = await fetch(url, { signal: control.signal })
      if (!respuesta.ok) {
        setError('No se pudieron cargar las series.')
        setCargando(false)
        return
      }

      const validado = esquemaRespuesta.safeParse(await respuesta.json())
      if (!validado.success) {
        setError('El servidor devolvió datos con una forma inesperada.')
        setCargando(false)
        return
      }

      const { eventos: recibidos, ...resto } = validado.data
      setDatos(resto)
      setEventos(recibidos)
      setCargando(false)
    } catch (causa) {
      // Abortar no es un error: es que el usuario cambió de rango.
      if (causa instanceof DOMException && causa.name === 'AbortError') return
      setError('No se pudo conectar con el servidor.')
      setCargando(false)
    }
  }, [seriesTexto, rango, desde, hasta])

  useEffect(() => {
    void cargar()
    return () => abortador.current?.abort()
    // `clave` resume todas las entradas en una sola cadena estable.
  }, [clave, cargar])

  return {
    datos,
    eventos,
    cargando,
    error,
    recargar: useCallback(() => setVersion((n) => n + 1), []),
  }
}
