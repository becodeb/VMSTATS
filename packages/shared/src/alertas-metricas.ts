import type { MetricaAlerta } from './alertas.js'
import type { MuestraContenedor } from './contenedores.js'
import type { MuestraHost } from './host.js'
import { porcentajeDe } from './formato.js'

/* ============================================================================
 * De una muestra al valor escalar que evalúa una regla.
 *
 * Devolver `null` significa «esta métrica no existe en este host» — no hay PSI,
 * no hay swap configurada, no hay Docker. Una regla sobre una métrica ausente
 * no se evalúa: no dispara ni se resuelve, se queda quieta. Cualquier otra
 * opción sería inventar un valor y alertar (o dejar de alertar) sobre él.
 * ========================================================================== */

export interface ContextoMetricas {
  host: MuestraHost
  contenedores: readonly MuestraContenedor[]
  /** Segundos desde el último dato del collector. */
  silencioSegundos: number
}

function sumaRed(host: MuestraHost, direccion: 'rx' | 'tx'): number {
  let total = 0
  for (const interfaz of host.red) {
    total += direccion === 'rx' ? interfaz.rxBytesPorSeg : interfaz.txBytesPorSeg
  }
  return total
}

/**
 * Tipos que están al 100 % por diseño y no son un problema.
 *
 * Un `squashfs` de snap o un `iso9660` montado están comprimidos y sellados:
 * nunca tienen espacio libre. Alertar sobre ellos genera un crítico permanente
 * que nadie puede resolver, y a la semana se ignoran todas las alertas de
 * disco. El collector ya los excluye de la lista; esto es la segunda barrera,
 * por si llegan de una muestra vieja.
 */
const TIPOS_SIEMPRE_LLENOS = new Set(['squashfs', 'iso9660', 'erofs', 'cramfs'])

/** El filesystem más lleno: si uno solo se llena, el sistema se rompe igual. */
function discoMasLleno(host: MuestraHost): number | null {
  let peor: number | null = null
  for (const fs of host.filesystems) {
    if (TIPOS_SIEMPRE_LLENOS.has(fs.tipo)) continue
    const porcentaje = porcentajeDe(fs.usado, fs.tamanio)
    if (porcentaje === null) continue
    if (peor === null || porcentaje > peor) peor = porcentaje
  }
  return peor
}

/**
 * Contenedores en problemas.
 *
 * `exited` no cuenta: un contenedor de tarea puntual que terminó bien está
 * `exited` y alertar por eso sería ruido puro. Lo que cuenta es un healthcheck
 * fallando, un contenedor reiniciándose en loop, o uno muerto.
 */
function contenedoresCaidos(contenedores: readonly MuestraContenedor[]): number {
  let cuenta = 0
  for (const contenedor of contenedores) {
    if (contenedor.salud === 'unhealthy') cuenta += 1
    else if (contenedor.estado === 'restarting' || contenedor.estado === 'dead') cuenta += 1
  }
  return cuenta
}

export function valorDeMetrica(
  metrica: MetricaAlerta,
  contexto: ContextoMetricas,
): number | null {
  const { host, contenedores, silencioSegundos } = contexto

  switch (metrica) {
    case 'cpu.total':
      return host.cpu.total
    case 'cpu.iowait':
      return host.cpu.iowait
    case 'cpu.steal':
      return host.cpu.steal
    case 'memoria.usadaPorcentaje':
      return porcentajeDe(host.memoria.usada, host.memoria.total)
    case 'memoria.swapPorcentaje':
      // Sin swap configurada la métrica no existe; un 0 diría «hay swap y está
      // vacía», que es una afirmación distinta.
      return host.memoria.swapTotal === 0
        ? null
        : porcentajeDe(host.memoria.swapUsada, host.memoria.swapTotal)
    case 'carga.porNucleo':
      return host.carga.nucleos > 0 ? host.carga.uno / host.carga.nucleos : null
    case 'disco.usadoPorcentaje':
      return discoMasLleno(host)
    case 'red.rxBytesPorSeg':
      return sumaRed(host, 'rx')
    case 'red.txBytesPorSeg':
      return sumaRed(host, 'tx')
    case 'presion.cpu':
      return host.presion.cpu?.some10 ?? null
    case 'presion.memoria':
      return host.presion.memoria?.some10 ?? null
    case 'presion.io':
      return host.presion.io?.some10 ?? null
    case 'contenedor.caido':
      return host.capacidades.contenedores ? contenedoresCaidos(contenedores) : null
    case 'collector.silencioSegundos':
      return silencioSegundos
  }
}
