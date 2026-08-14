import { useCallback, useEffect, useRef, useState } from 'react'
import {
  esquemaInstantanea,
  datosDesactualizados,
  type Instantanea,
} from '@vmstats/shared'

/* ============================================================================
 * Conexión de tiempo real.
 *
 * `EventSource` reconecta solo, pero con un intervalo fijo que no se puede
 * configurar: contra un servidor caído machaca cada 3 segundos indefinidamente.
 * Por eso se maneja la reconexión a mano — cerramos el `EventSource` ante el
 * primer error y reabrimos con backoff exponencial.
 *
 * Tres comportamientos que la spec pide y que están acá:
 *
 *  - Reanudar sin huecos: el id del último evento recibido viaja como query
 *    param al reconectar (`EventSource` no permite mandar cabeceras, así que
 *    `Last-Event-ID` no sirve del lado del cliente).
 *  - Frenar con la pestaña oculta: sin esto, diez pestañas de fondo mantienen
 *    diez conexiones abiertas contra una VM chica.
 *  - Fallback a polling si el SSE no logra establecerse.
 * ========================================================================== */

export type EstadoConexion = 'conectando' | 'conectado' | 'reconectando' | 'polling' | 'pausado'

/** Tras estos intentos fallidos, se deja el SSE y se pasa a polling. */
const INTENTOS_ANTES_DE_POLLING = 4
const INTERVALO_POLLING_MS = 15_000
const BACKOFF_MAXIMO_MS = 30_000

export interface EstadoFlujo {
  instantanea: Instantanea | null
  conexion: EstadoConexion
  /** true cuando el collector dejó de reportar. */
  desactualizado: boolean
  /** Última vez que llegó cualquier dato, para el reloj de la UI. */
  recibidoEn: Date | null
}

export function useFlujo(instantaneaInicial: Instantanea | null): EstadoFlujo {
  const [instantanea, setInstantanea] = useState<Instantanea | null>(instantaneaInicial)
  const [conexion, setConexion] = useState<EstadoConexion>('conectando')
  const [recibidoEn, setRecibidoEn] = useState<Date | null>(
    instantaneaInicial === null ? null : new Date(),
  )

  const fuente = useRef<EventSource | null>(null)
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sondeo = useRef<ReturnType<typeof setInterval> | null>(null)
  const ultimoId = useRef(0)
  const intentos = useRef(0)
  const desmontado = useRef(false)

  const aplicar = useCallback((datos: unknown) => {
    const validada = esquemaInstantanea.safeParse(datos)
    // Un evento con forma inesperada (versiones desalineadas entre web y
    // collector) se descarta: mejor mantener el último dato bueno que pintar
    // la consola con campos vacíos.
    if (!validada.success) return
    setInstantanea(validada.data)
    setRecibidoEn(new Date())
  }, [])

  const limpiar = useCallback(() => {
    fuente.current?.close()
    fuente.current = null
    if (temporizador.current !== null) clearTimeout(temporizador.current)
    temporizador.current = null
    if (sondeo.current !== null) clearInterval(sondeo.current)
    sondeo.current = null
  }, [])

  const sondear = useCallback(async () => {
    try {
      const respuesta = await fetch('/api/instantanea', { headers: { Accept: 'application/json' } })
      if (!respuesta.ok) return
      aplicar(await respuesta.json())
    } catch {
      // Sin red: el banner de datos desactualizados ya lo comunica.
    }
  }, [aplicar])

  const iniciarPolling = useCallback(() => {
    if (sondeo.current !== null) return
    setConexion('polling')
    void sondear()
    sondeo.current = setInterval(() => void sondear(), INTERVALO_POLLING_MS)
  }, [sondear])

  const conectar = useCallback(() => {
    if (desmontado.current) return
    limpiar()

    const url = new URL('/api/flujo', window.location.origin)
    if (ultimoId.current > 0) url.searchParams.set('desde', String(ultimoId.current))

    const es = new EventSource(url)
    fuente.current = es

    es.addEventListener('open', () => {
      intentos.current = 0
      setConexion('conectado')
    })

    const alRecibir = (evento: MessageEvent<string>) => {
      const id = Number.parseInt(evento.lastEventId, 10)
      if (Number.isFinite(id)) ultimoId.current = id
      try {
        aplicar(JSON.parse(evento.data))
      } catch {
        // Payload roto: se ignora este evento, la conexión sigue.
      }
    }

    es.addEventListener('instantanea', alRecibir as EventListener)

    // El latido no trae datos: sólo confirma que el túnel sigue vivo.
    es.addEventListener('latido', () => setRecibidoEn(new Date()))

    es.addEventListener('error', () => {
      es.close()
      fuente.current = null
      if (desmontado.current) return

      intentos.current += 1
      if (intentos.current >= INTENTOS_ANTES_DE_POLLING) {
        iniciarPolling()
        return
      }

      setConexion('reconectando')
      const espera = Math.min(BACKOFF_MAXIMO_MS, 1000 * 2 ** (intentos.current - 1))
      temporizador.current = setTimeout(conectar, espera)
    })
  }, [aplicar, iniciarPolling, limpiar])

  useEffect(() => {
    desmontado.current = false
    conectar()

    /* Pestaña oculta: se corta la conexión.
     *
     * Se espera 60 s antes de cortar para no reconectar en cada cambio de
     * pestaña de alguien que compara dos ventanas. */
    let apagado: ReturnType<typeof setTimeout> | null = null

    const alCambiarVisibilidad = () => {
      if (document.visibilityState === 'hidden') {
        apagado = setTimeout(() => {
          limpiar()
          setConexion('pausado')
        }, 60_000)
      } else {
        if (apagado !== null) clearTimeout(apagado)
        apagado = null
        if (fuente.current === null && sondeo.current === null) {
          intentos.current = 0
          conectar()
        }
      }
    }

    document.addEventListener('visibilitychange', alCambiarVisibilidad)

    return () => {
      desmontado.current = true
      if (apagado !== null) clearTimeout(apagado)
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      limpiar()
    }
  }, [conectar, limpiar])

  /* El «desactualizado» se recalcula con un reloj propio: si el collector deja
   * de emitir, no llega ningún evento que dispare un re-render, y sin este
   * tick la UI se quedaría mostrando datos viejos como si fueran actuales. */
  const [, forzarRedibujo] = useState(0)
  const [montado, setMontado] = useState(false)

  useEffect(() => {
    setMontado(true)
    const tick = setInterval(() => forzarRedibujo((n) => n + 1), 5000)
    return () => clearInterval(tick)
  }, [])

  const ultimoLatido = instantanea?.ultimoLatido ?? null

  /* La frescura se decide recién después de montar.
   *
   * `datosDesactualizados` compara contra el reloj actual, y el servidor
   * renderiza en un instante distinto del que hidrata el navegador. Si los dos
   * caen a lados opuestos del umbral, React ve un árbol distinto del que
   * generó y descarta la hidratación con un error — que fue exactamente lo que
   * pasó: el servidor pintaba el banner de datos viejos y el cliente no.
   *
   * Antes de montar se asume fresco, que es lo que el servidor acaba de
   * afirmar al mandar la instantánea. El valor real aparece un instante
   * después, junto con el primer tick. */
  const desactualizado =
    montado && datosDesactualizados(ultimoLatido === null ? null : new Date(ultimoLatido))

  return { instantanea, conexion, desactualizado, recibidoEn }
}
