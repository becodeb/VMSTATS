import type { EstadoContenedor, EstadoSalud, Puerto } from '@vmstats/shared'
import { ESTADOS_CONTENEDOR } from '@vmstats/shared'
import type {
  PuertoDocker,
  StatsBlkioDocker,
  StatsCpuDocker,
  StatsMemoriaDocker,
  StatsRedDocker,
} from './cliente.js'

/* ============================================================================
 * De la respuesta cruda de Docker a nuestros tipos.
 *
 * Todo lo de este archivo es puro. La aritmética de las stats de Docker tiene
 * varias trampas conocidas (la memoria que hay que descontar, el porcentaje de
 * CPU que depende de la cantidad de núcleos) y acá se pueden testear con
 * respuestas capturadas de un Docker real.
 * ========================================================================== */

/**
 * Porcentaje de CPU del contenedor.
 *
 * Docker publica nanosegundos de CPU acumulados, no un porcentaje. La fórmula
 * canónica compara el delta del contenedor contra el delta del sistema y
 * escala por la cantidad de núcleos, de modo que un contenedor que satura dos
 * núcleos marca 200 %, igual que en `docker stats`.
 */
export function calcularCpuContenedor(
  actual: StatsCpuDocker,
  previo: StatsCpuDocker | null,
  segundosTranscurridos: number,
): number {
  if (previo === null) return 0

  const cpuDelta = actual.cpu_usage.total_usage - previo.cpu_usage.total_usage
  if (cpuDelta <= 0) return 0

  const nucleos = actual.online_cpus ?? 1
  const sistemaActual = actual.system_cpu_usage
  const sistemaPrevio = previo.system_cpu_usage

  if (sistemaActual !== undefined && sistemaPrevio !== undefined) {
    const sistemaDelta = sistemaActual - sistemaPrevio
    if (sistemaDelta > 0) {
      return (cpuDelta / sistemaDelta) * nucleos * 100
    }
  }

  // cgroup v2 no siempre publica `system_cpu_usage`. El total del contenedor
  // ya viene en nanosegundos de CPU, así que se puede comparar directamente
  // contra el tiempo real del intervalo sin pasar por el total del sistema.
  if (segundosTranscurridos <= 0) return 0
  return (cpuDelta / (segundosTranscurridos * 1e9)) * 100
}

/**
 * Memoria realmente usada.
 *
 * `memory_stats.usage` incluye la page cache, y contarla haría ver a cualquier
 * contenedor que leyó un archivo grande como si estuviera al límite. Se
 * descuenta `inactive_file` (cgroup v2) o `total_inactive_file` (v1), que es
 * exactamente lo que hace `docker stats`.
 */
export function calcularMemoriaContenedor(stats: StatsMemoriaDocker): number {
  const uso = stats.usage ?? 0
  const detalle = stats.stats ?? {}
  const inactiva = detalle['inactive_file'] ?? detalle['total_inactive_file'] ?? 0
  return Math.max(0, uso - inactiva)
}

/**
 * Límite de memoria, o null si no hay.
 *
 * Sin límite, Docker reporta la RAM total del host. Devolverlo como «límite»
 * haría que la UI dibuje una barra de uso contra un tope que no existe, así
 * que se detecta y se informa como «sin límite».
 */
export function calcularLimiteMemoria(
  stats: StatsMemoriaDocker,
  memoriaTotalHost: number,
): number | null {
  const limite = stats.limit
  if (limite === undefined || limite <= 0) return null
  // Margen del 1 %: el total que ve Docker y el que leemos de /proc/meminfo
  // difieren por unos pocos KiB.
  if (memoriaTotalHost > 0 && limite >= memoriaTotalHost * 0.99) return null
  return limite
}

export function sumarRed(redes: Record<string, StatsRedDocker> | undefined): {
  rx: number
  tx: number
} {
  if (redes === undefined) return { rx: 0, tx: 0 }
  let rx = 0
  let tx = 0
  for (const red of Object.values(redes)) {
    rx += red.rx_bytes
    tx += red.tx_bytes
  }
  return { rx, tx }
}

export function sumarBlkio(blkio: StatsBlkioDocker | undefined): {
  lectura: number
  escritura: number
} {
  const entradas = blkio?.io_service_bytes_recursive
  if (entradas === undefined || entradas === null) return { lectura: 0, escritura: 0 }

  let lectura = 0
  let escritura = 0
  for (const entrada of entradas) {
    const op = entrada.op.toLowerCase()
    if (op === 'read') lectura += entrada.value
    else if (op === 'write') escritura += entrada.value
  }
  return { lectura, escritura }
}

const ESTADOS_VALIDOS = new Set<string>(ESTADOS_CONTENEDOR)

export function normalizarEstado(estado: string): EstadoContenedor {
  const limpio = estado.toLowerCase()
  return ESTADOS_VALIDOS.has(limpio) ? (limpio as EstadoContenedor) : 'dead'
}

/**
 * Salud desde el campo `Status` del listado.
 *
 * Docker la incluye entre paréntesis: «Up 2 hours (healthy)». Sacarla de acá
 * evita un `inspect` por contenedor en cada ciclo, que a 5 segundos y treinta
 * contenedores es tráfico que no hace falta.
 */
export function saludDesdeStatus(status: string): EstadoSalud {
  const coincidencia = /\((healthy|unhealthy|health: starting|starting)\)/i.exec(status)
  const capturado = coincidencia?.[1]?.toLowerCase()
  if (capturado === undefined) return 'none'
  if (capturado === 'healthy') return 'healthy'
  if (capturado === 'unhealthy') return 'unhealthy'
  return 'starting'
}

export function normalizarPuertos(
  puertos: readonly PuertoDocker[] | null | undefined,
): Puerto[] {
  // Docker manda `null`, no `[]`, cuando el contenedor no publica puertos.
  if (puertos === null || puertos === undefined) return []
  return puertos.map((p) => ({
    privado: p.PrivatePort,
    publico: p.PublicPort ?? null,
    protocolo: p.Type,
    ip: p.IP ?? null,
  }))
}

/** El nombre viene con una barra adelante y puede haber alias. */
export function nombreContenedor(nombres: readonly string[] | null | undefined): string {
  const primero = nombres?.[0]
  if (primero === undefined) return '(sin nombre)'
  return primero.startsWith('/') ? primero.slice(1) : primero
}

export interface IdentidadCoolify {
  aplicacion: string | null
  uuid: string | null
}

/**
 * Identifica contenedores administrados por Coolify a partir de sus labels.
 *
 * Coolify cambió los nombres de sus labels entre versiones, así que se
 * prueban varias claves conocidas y se cae al proyecto de compose. Que no se
 * pueda identificar no es un error: un contenedor levantado a mano en la misma
 * VM aparece igual, sólo que sin aplicación asociada.
 */
export function identidadCoolify(
  labels: Record<string, string> | null | undefined,
): IdentidadCoolify {
  const etiquetas = labels ?? {}
  const primera = (...claves: string[]): string | null => {
    for (const clave of claves) {
      const valor = etiquetas[clave]
      if (valor !== undefined && valor.length > 0) return valor
    }
    return null
  }

  const uuid = primera(
    'coolify.applicationId',
    'coolify.resourceUuid',
    'coolify.serviceId',
    'coolify.uuid',
  )
  const aplicacion = primera(
    'coolify.name',
    'coolify.resourceName',
    'coolify.applicationName',
    'coolify.serviceName',
  )

  // Sin labels de Coolify, el proyecto de compose es la mejor agrupación que
  // tenemos y sirve igual para filtrar en la UI.
  if (uuid === null && aplicacion === null) {
    const proyecto = etiquetas['com.docker.compose.project']
    if (proyecto !== undefined && etiquetas['coolify.managed'] === 'true') {
      return { aplicacion: proyecto, uuid: null }
    }
    return { aplicacion: null, uuid: null }
  }

  return { aplicacion, uuid }
}
