import type { Cpu, Disco, InterfazRed } from '@vmstats/shared'
import {
  BYTES_POR_SECTOR,
  type EstadoStat,
  type StatsDisco,
  type StatsRed,
  type TiemposCpu,
} from './parsers.js'

/* ============================================================================
 * De contadores acumulados a tasas.
 *
 * /proc casi no publica tasas: publica contadores que sólo suben desde el
 * arranque. Todo lo que se muestra como «por segundo» sale de restar dos
 * lecturas y dividir por el tiempo entre ellas. Esa resta es donde se esconden
 * los bugs clásicos de un collector, así que vive acá, pura y testeada.
 * ========================================================================== */

/**
 * USER_HZ. El kernel expone los tiempos de CPU en jiffies y la constante es
 * 100 en prácticamente todas las builds de Linux para x86_64 y arm64.
 *
 * Igual, para los porcentajes de CPU no importa: se calculan como fracción del
 * total de jiffies del intervalo, así que la constante se cancela. Sólo hace
 * falta para el CPU por proceso, donde se compara contra tiempo real.
 */
export const JIFFIES_POR_SEGUNDO = 100

/**
 * Diferencia de un contador monótono.
 *
 * Si el valor bajó, el contador se reinició — la máquina rebootó, la interfaz
 * se recreó, el contador de 32 bits dio la vuelta. En todos esos casos la
 * respuesta honesta es 0: no sabemos cuánto pasó realmente, e inventar el
 * valor nuevo como si fuera el delta produce un pico gigante y falso justo
 * después de cada reinicio.
 */
export function delta(actual: number, previo: number): number {
  const d = actual - previo
  return d < 0 ? 0 : d
}

/** Delta convertido a tasa por segundo. */
export function tasa(actual: number, previo: number, segundos: number): number {
  if (segundos <= 0) return 0
  return delta(actual, previo) / segundos
}

function sumaJiffies(t: TiemposCpu): number {
  return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal
}

/**
 * Porcentajes de CPU entre dos lecturas de /proc/stat.
 *
 * `total` se define como `100 - idle`, con iowait contando como ocupado. Es la
 * convención de la mayoría de los dashboards y la que hace que el número
 * grande coincida con lo que la gente espera ver. El iowait se publica aparte
 * igual, que es donde se lo puede interpretar bien.
 */
export function derivarCpu(actual: TiemposCpu, previo: TiemposCpu): Omit<Cpu, 'porNucleo'> {
  const totalDelta = sumaJiffies(actual) - sumaJiffies(previo)

  // Dos lecturas dentro del mismo jiffy, o un contador reiniciado: sin
  // intervalo no hay porcentaje que calcular.
  if (totalDelta <= 0) {
    return {
      total: 0, user: 0, system: 0, nice: 0, idle: 100,
      iowait: 0, irq: 0, softirq: 0, steal: 0,
    }
  }

  const pct = (a: number, p: number): number => (delta(a, p) / totalDelta) * 100
  const idle = pct(actual.idle, previo.idle)

  return {
    total: Math.min(100, Math.max(0, 100 - idle)),
    user: pct(actual.user, previo.user),
    system: pct(actual.system, previo.system),
    nice: pct(actual.nice, previo.nice),
    idle,
    iowait: pct(actual.iowait, previo.iowait),
    irq: pct(actual.irq, previo.irq),
    softirq: pct(actual.softirq, previo.softirq),
    steal: pct(actual.steal, previo.steal),
  }
}

export function derivarCpuCompleto(actual: EstadoStat, previo: EstadoStat): Cpu {
  const base = derivarCpu(actual.total, previo.total)

  const porNucleo = actual.porNucleo.map((nucleo, i) => {
    const anterior = previo.porNucleo[i]
    // Núcleo nuevo (hotplug) o primera lectura: 0 es más honesto que
    // extrapolar desde un núcleo distinto.
    if (anterior === undefined) return 0
    return derivarCpu(nucleo, anterior).total
  })

  return { ...base, porNucleo }
}

export function derivarDiscos(
  actuales: readonly StatsDisco[],
  previos: readonly StatsDisco[],
  segundos: number,
): Disco[] {
  const indice = new Map(previos.map((d) => [d.dispositivo, d]))

  return actuales.flatMap((actual) => {
    const previo = indice.get(actual.dispositivo)
    // Dispositivo que aparece por primera vez: sin base no hay tasa. Se lo
    // saltea esta vuelta y entra en la siguiente.
    if (previo === undefined) return []

    const lecturaOps = tasa(actual.lecturas, previo.lecturas, segundos)
    const escrituraOps = tasa(actual.escrituras, previo.escrituras, segundos)
    const msLeyendo = delta(actual.msLeyendo, previo.msLeyendo)
    const msEscribiendo = delta(actual.msEscribiendo, previo.msEscribiendo)
    const lecturas = delta(actual.lecturas, previo.lecturas)
    const escrituras = delta(actual.escrituras, previo.escrituras)

    // Utilización: fracción del intervalo con I/O en vuelo. Puede pasarse de
    // 100 en dispositivos con varias colas, así que se recorta.
    const msEnIo = delta(actual.msEnIo, previo.msEnIo)
    const utilizacion = segundos > 0 ? Math.min(100, (msEnIo / (segundos * 1000)) * 100) : 0

    return [{
      dispositivo: actual.dispositivo,
      lecturaBytesPorSeg:
        tasa(actual.sectoresLeidos, previo.sectoresLeidos, segundos) * BYTES_POR_SECTOR,
      escrituraBytesPorSeg:
        tasa(actual.sectoresEscritos, previo.sectoresEscritos, segundos) * BYTES_POR_SECTOR,
      lecturaOpsPorSeg: lecturaOps,
      escrituraOpsPorSeg: escrituraOps,
      utilizacion,
      // Latencia media por operación. Sin operaciones en el intervalo no hay
      // latencia que promediar: null, no 0. Un 0 diría «respondió al instante».
      latenciaLecturaMs: lecturas > 0 ? msLeyendo / lecturas : null,
      latenciaEscrituraMs: escrituras > 0 ? msEscribiendo / escrituras : null,
    }]
  })
}

export function derivarRed(
  actuales: readonly StatsRed[],
  previos: readonly StatsRed[],
  segundos: number,
): InterfazRed[] {
  const indice = new Map(previos.map((r) => [r.interfaz, r]))

  return actuales.flatMap((actual) => {
    const previo = indice.get(actual.interfaz)
    if (previo === undefined) return []

    return [{
      interfaz: actual.interfaz,
      rxBytesPorSeg: tasa(actual.rxBytes, previo.rxBytes, segundos),
      txBytesPorSeg: tasa(actual.txBytes, previo.txBytes, segundos),
      rxPaquetesPorSeg: tasa(actual.rxPaquetes, previo.rxPaquetes, segundos),
      txPaquetesPorSeg: tasa(actual.txPaquetes, previo.txPaquetes, segundos),
      // Los errores y descartes se muestran como delta del intervalo, no como
      // acumulado: lo que importa es «¿está pasando ahora?».
      rxErrores: delta(actual.rxErrores, previo.rxErrores),
      txErrores: delta(actual.txErrores, previo.txErrores),
      rxDescartes: delta(actual.rxDescartes, previo.rxDescartes),
      txDescartes: delta(actual.txDescartes, previo.txDescartes),
    }]
  })
}

/**
 * CPU de un proceso: jiffies consumidos sobre tiempo real transcurrido.
 *
 * Puede pasar de 100 en un proceso multihilo, y está bien — un proceso que usa
 * cuatro núcleos al 100 % marca 400 %, igual que en `top`.
 */
export function derivarCpuProceso(
  jiffiesActual: number,
  jiffiesPrevio: number,
  segundos: number,
): number {
  if (segundos <= 0) return 0
  const jiffiesConsumidos = delta(jiffiesActual, jiffiesPrevio)
  return (jiffiesConsumidos / JIFFIES_POR_SEGUNDO / segundos) * 100
}
