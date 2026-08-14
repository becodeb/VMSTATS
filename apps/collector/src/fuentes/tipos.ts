import type { Capacidades, MuestraContenedor, MuestraHost } from '@vmstats/shared'

/* ============================================================================
 * Fuentes de métricas.
 *
 * El collector no sabe de dónde vienen los números. Esta interfaz es la razón
 * por la que se puede desarrollar y testear el pipeline entero fuera de Linux:
 * `FuenteProcfs` lee /proc de verdad, `FuenteFixture` lee archivos capturados
 * de un host real, `FuenteDemo` genera series sintéticas detrás de un flag.
 *
 * Todas producen exactamente el mismo tipo, así que nada aguas abajo cambia.
 * ========================================================================== */

export interface FuenteHost {
  /**
   * Toma una muestra.
   *
   * Devuelve `null` en la primera llamada: casi todo /proc son contadores
   * acumulados y hace falta una lectura previa para poder calcular tasas.
   * Reportar ceros en la primera muestra sería un valle falso al arranque.
   */
  muestrear(): Promise<MuestraHost | null>

  /** Qué se pudo leer efectivamente en este host. */
  capacidades(): Capacidades

  /** Identificador estable del host, para la clave de las tablas. */
  hostId(): Promise<string>
}

export interface FuenteContenedores {
  muestrear(): Promise<MuestraContenedor[]>
  /** false si no hay acceso a Docker; la UI muestra «No disponible». */
  disponible(): boolean
}

/** Todo lo que el collector pudo o no pudo hacer, en un solo lugar. */
export const CAPACIDADES_VACIAS: Capacidades = {
  presion: false,
  temperatura: false,
  ioDisco: false,
  latenciaIo: false,
  procesos: false,
  contenedores: false,
  coolify: false,
}
