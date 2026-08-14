import { useCallback, useEffect, useRef, useState } from 'react'
import {
  INTERVALO_LATIDO_MS,
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

/**
 * Cada cuánto se reintenta el SSE estando en polling.
 *
 * Sin esto el polling era un callejón sin salida: una vez que se caía ahí, la
 * consola se quedaba sondeando cada 15 s hasta que alguien recargara la página.
 * Un corte de red de diez segundos degradaba la sesión entera.
 *
 * Un minuto es el compromiso: lo bastante seguido como para volver al tiempo
 * real enseguida, lo bastante espaciado como para no castigar a un servidor que
 * está caído.
 */
const INTERVALO_REINTENTO_SSE_MS = 60_000

/**
 * Cuánto silencio se tolera antes de dar el túnel por muerto.
 *
 * `EventSource` sólo emite `error` cuando el socket se cierra. Hay un modo de
 * fallo más común que ése y que no lo dispara: la conexión queda ABIERTA pero
 * muda —la red se cae a mitad del stream, el portátil suspende, el móvil cambia
 * de celda, un proxy retiene el socket—. Sin vigilancia propia, la consola se
 * queda mostrando «En vivo» con datos congelados por tiempo indefinido.
 *
 * Apareció probando la reconexión contra el servidor real: al cortar la red del
 * navegador, el estado nunca pasaba a «Reconectando».
 *
 * Dos latidos y medio: uno perdido puede ser un pico de carga, dos seguidos ya
 * no.
 */
const UMBRAL_SILENCIO_MS = INTERVALO_LATIDO_MS * 2.5

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
  /** Corta el túnel si deja de llegar cualquier cosa. Ver UMBRAL_SILENCIO_MS. */
  const vigilante = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Reintento del SSE mientras se sondea. Ver INTERVALO_REINTENTO_SSE_MS. */
  const reintento = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ultimoId = useRef(0)
  const intentos = useRef(0)
  const desmontado = useRef(false)
  const conectarRef = useRef<() => void>(() => {})

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
    if (vigilante.current !== null) clearTimeout(vigilante.current)
    vigilante.current = null
    if (reintento.current !== null) clearTimeout(reintento.current)
    reintento.current = null
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

    /* El polling no es un destino, es una sala de espera.
     *
     * Se vuelve a probar el SSE al minuto. `intentos` se reinicia para que el
     * intento nuevo tenga su propio ciclo de backoff en vez de rendirse al
     * primer error por venir de una tanda anterior ya agotada. */
    reintento.current = setTimeout(() => {
      intentos.current = 0
      conectarRef.current()
    }, INTERVALO_REINTENTO_SSE_MS)
  }, [sondear])

  const conectar = useCallback(() => {
    if (desmontado.current) return
    limpiar()

    const url = new URL('/api/flujo', window.location.origin)
    if (ultimoId.current > 0) url.searchParams.set('desde', String(ultimoId.current))

    const es = new EventSource(url)
    fuente.current = es

    /* Única ruta de caída, para el error explícito y para el silencio.
     *
     * `es` queda capturado por cierre, así que si mientras tanto se abrió otra
     * conexión, la comprobación de identidad evita que un temporizador viejo
     * tire la nueva. */
    const caer = () => {
      if (fuente.current !== es) return
      es.close()
      fuente.current = null
      if (vigilante.current !== null) clearTimeout(vigilante.current)
      vigilante.current = null
      if (desmontado.current) return

      intentos.current += 1
      if (intentos.current >= INTENTOS_ANTES_DE_POLLING) {
        iniciarPolling()
        return
      }

      setConexion('reconectando')
      const espera = Math.min(BACKOFF_MAXIMO_MS, 1000 * 2 ** (intentos.current - 1))
      temporizador.current = setTimeout(conectarRef.current, espera)
    }

    /** Rearma la cuenta atrás. Se llama con cada cosa que llegue por el túnel. */
    const hayVida = () => {
      if (vigilante.current !== null) clearTimeout(vigilante.current)
      vigilante.current = setTimeout(caer, UMBRAL_SILENCIO_MS)
    }

    es.addEventListener('open', () => {
      intentos.current = 0
      setConexion('conectado')
      hayVida()
    })

    const alRecibir = (evento: MessageEvent<string>) => {
      hayVida()
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
    es.addEventListener('latido', () => {
      hayVida()
      setRecibidoEn(new Date())
    })

    es.addEventListener('error', caer)
  }, [aplicar, iniciarPolling, limpiar])

  /* `caer` necesita volver a llamar a `conectar`, y `conectar` crea a `caer`.
   * La referencia rompe el ciclo sin que ninguna de las dos se recree en cada
   * render, que es lo que reabriría la conexión sola. */
  useEffect(() => {
    conectarRef.current = conectar
  }, [conectar])

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
