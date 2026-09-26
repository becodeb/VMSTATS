import { sql } from 'drizzle-orm'
import type { BaseDatos } from '@vmstats/db'

/* ============================================================================
 * Agregación progresiva: crudos → 5 minutos → 15 minutos.
 *
 * Decisiones que vale la pena dejar escritas:
 *
 * 1. Se recalcula una ventana móvil reciente en cada corrida, en vez de llevar
 *    una marca de agua, y al arrancar el collector una ventana larga que cubre
 *    toda la retención del origen. `ON CONFLICT DO UPDATE` hace que recalcular
 *    sea inofensivo, así que el sistema se repara solo después de una caída.
 *
 * 2. Un bucket ya guardado sólo se reescribe si el recálculo resume MÁS
 *    muestras que antes (`sample_count`). Recalcular un bucket cerrado da lo
 *    mismo, y reescribirlo igual era lo que generaba millones de tuplas
 *    muertas y tenía al Postgres de la VM al 70 % de CPU. La misma regla evita
 *    que un recálculo sobre un origen que la retención ya empezó a recortar
 *    pise un agregado completo con uno parcial.
 *
 * 3. Sólo se agregan buckets ya cerrados. Un bucket del intervalo en curso está
 *    incompleto; se agrega en la próxima corrida, cuando cerró.
 *
 * 4. Gauges y tasas se promedian; contadores de eventos (errores, descartes) se
 *    suman; lo monótono o identitario (uptime, reinicios, memoria total) va con
 *    `max`; el filesystem se queda con el último valor del bucket, que describe
 *    mejor «cuánto disco había» que un promedio.
 * ========================================================================== */

export type Origen = 'raw' | '5m'
export type Destino = '5m' | '15m'

export interface PlanRollup {
  origen: Origen
  destino: Destino
  /** Ancho del bucket, como intervalo de PostgreSQL. */
  intervalo: string
  /** Cuánto hacia atrás recalcular en cada corrida normal. */
  ventanaHoras: number
  /** Cuánto hacia atrás recalcular en la primera corrida después de arrancar.
   *  Tiene que quedar dentro de la retención del origen. */
  ventanaArranqueHoras: number
}

export const PLANES: readonly PlanRollup[] = [
  { origen: 'raw', destino: '5m', intervalo: '5 minutes', ventanaHoras: 1, ventanaArranqueHoras: 24 },
  { origen: '5m', destino: '15m', intervalo: '15 minutes', ventanaHoras: 3, ventanaArranqueHoras: 168 },
]

/**
 * Origen de la grilla de `date_bin`.
 *
 * Fijo y en UTC para que los buckets caigan siempre en los mismos bordes, sin
 * importar cuándo arrancó el proceso. Si el origen dependiera del arranque, dos
 * corridas distintas producirían grillas corridas entre sí y el mismo instante
 * caería en buckets diferentes.
 */
const ORIGEN_GRILLA = '2000-01-01T00:00:00Z'

export interface ResultadoRollup {
  destino: Destino
  filasHost: number
  filasRed: number
  filasDisco: number
  filasFilesystem: number
  filasContenedor: number
}

export async function correrRollup(
  db: BaseDatos,
  plan: PlanRollup,
  arranque = false,
): Promise<ResultadoRollup> {
  const horas = arranque ? plan.ventanaArranqueHoras : plan.ventanaHoras
  const desde = sql.raw(`now() - interval '${horas} hours'`)
  // El corte de arriba deja fuera el bucket en curso: `date_bin` sobre `now()`
  // devuelve el arranque del bucket actual, que todavía se está llenando.
  const hasta = sql.raw(`date_bin(interval '${plan.intervalo}', now(), timestamptz '${ORIGEN_GRILLA}')`)
  const bucket = sql.raw(
    `date_bin(interval '${plan.intervalo}', ts, timestamptz '${ORIGEN_GRILLA}')`,
  )

  const filasHost = await db.execute(sql`
    INSERT INTO host_metric_samples (
      host_id, resolution, ts,
      cpu_total, cpu_user, cpu_system, cpu_nice, cpu_idle,
      cpu_iowait, cpu_irq, cpu_softirq, cpu_steal, cpu_per_core,
      load_1, load_5, load_15, cores,
      mem_total, mem_used, mem_available, mem_free, mem_cached, mem_buffers,
      swap_total, swap_used, uptime_seconds,
      net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps,
      tcp_established, tcp_listen, tcp_time_wait, tcp_total,
      psi_cpu_some10, psi_mem_some10, psi_io_some10, pressure_detail,
      processes, temperatures, sample_count
    )
    SELECT
      host_id, ${plan.destino}::text, ${bucket} AS bucket,
      avg(cpu_total), avg(cpu_user), avg(cpu_system), avg(cpu_nice), avg(cpu_idle),
      avg(cpu_iowait), avg(cpu_irq), avg(cpu_softirq), avg(cpu_steal), '[]'::jsonb,
      avg(load_1), avg(load_5), avg(load_15), max(cores),
      max(mem_total), avg(mem_used), avg(mem_available), avg(mem_free),
      avg(mem_cached), avg(mem_buffers),
      max(swap_total), avg(swap_used), max(uptime_seconds),
      avg(net_rx_bps), avg(net_tx_bps), avg(disk_read_bps), avg(disk_write_bps),
      avg(tcp_established), avg(tcp_listen), avg(tcp_time_wait), avg(tcp_total),
      avg(psi_cpu_some10), avg(psi_mem_some10), avg(psi_io_some10), NULL,
      NULL, NULL, sum(sample_count)
    FROM host_metric_samples
    WHERE resolution = ${plan.origen} AND ts >= ${desde} AND ts < ${hasta}
    GROUP BY host_id, bucket
    ON CONFLICT (host_id, resolution, ts) DO UPDATE SET
      cpu_total = EXCLUDED.cpu_total, cpu_user = EXCLUDED.cpu_user,
      cpu_system = EXCLUDED.cpu_system, cpu_nice = EXCLUDED.cpu_nice,
      cpu_idle = EXCLUDED.cpu_idle, cpu_iowait = EXCLUDED.cpu_iowait,
      cpu_irq = EXCLUDED.cpu_irq, cpu_softirq = EXCLUDED.cpu_softirq,
      cpu_steal = EXCLUDED.cpu_steal,
      load_1 = EXCLUDED.load_1, load_5 = EXCLUDED.load_5, load_15 = EXCLUDED.load_15,
      mem_used = EXCLUDED.mem_used, mem_available = EXCLUDED.mem_available,
      mem_free = EXCLUDED.mem_free, mem_cached = EXCLUDED.mem_cached,
      mem_buffers = EXCLUDED.mem_buffers, swap_used = EXCLUDED.swap_used,
      uptime_seconds = EXCLUDED.uptime_seconds,
      net_rx_bps = EXCLUDED.net_rx_bps, net_tx_bps = EXCLUDED.net_tx_bps,
      disk_read_bps = EXCLUDED.disk_read_bps, disk_write_bps = EXCLUDED.disk_write_bps,
      tcp_established = EXCLUDED.tcp_established, tcp_listen = EXCLUDED.tcp_listen,
      tcp_time_wait = EXCLUDED.tcp_time_wait, tcp_total = EXCLUDED.tcp_total,
      psi_cpu_some10 = EXCLUDED.psi_cpu_some10,
      psi_mem_some10 = EXCLUDED.psi_mem_some10,
      psi_io_some10 = EXCLUDED.psi_io_some10,
      sample_count = EXCLUDED.sample_count
    WHERE EXCLUDED.sample_count > host_metric_samples.sample_count
  `)

  const filasRed = await db.execute(sql`
    INSERT INTO network_metric_samples (
      host_id, resolution, ts, interface,
      rx_bps, tx_bps, rx_pps, tx_pps,
      rx_errors, tx_errors, rx_drops, tx_drops, sample_count
    )
    SELECT
      host_id, ${plan.destino}::text, ${bucket} AS bucket, interface,
      avg(rx_bps), avg(tx_bps), avg(rx_pps), avg(tx_pps),
      sum(rx_errors), sum(tx_errors), sum(rx_drops), sum(tx_drops), sum(sample_count)
    FROM network_metric_samples
    WHERE resolution = ${plan.origen} AND ts >= ${desde} AND ts < ${hasta}
    GROUP BY host_id, bucket, interface
    ON CONFLICT (host_id, resolution, ts, interface) DO UPDATE SET
      rx_bps = EXCLUDED.rx_bps, tx_bps = EXCLUDED.tx_bps,
      rx_pps = EXCLUDED.rx_pps, tx_pps = EXCLUDED.tx_pps,
      rx_errors = EXCLUDED.rx_errors, tx_errors = EXCLUDED.tx_errors,
      rx_drops = EXCLUDED.rx_drops, tx_drops = EXCLUDED.tx_drops,
      sample_count = EXCLUDED.sample_count
    WHERE EXCLUDED.sample_count > network_metric_samples.sample_count
  `)

  const filasDisco = await db.execute(sql`
    INSERT INTO disk_metric_samples (
      host_id, resolution, ts, device,
      read_bps, write_bps, read_ops, write_ops,
      utilization, read_latency_ms, write_latency_ms, sample_count
    )
    SELECT
      host_id, ${plan.destino}::text, ${bucket} AS bucket, device,
      avg(read_bps), avg(write_bps), avg(read_ops), avg(write_ops),
      avg(utilization), avg(read_latency_ms), avg(write_latency_ms), sum(sample_count)
    FROM disk_metric_samples
    WHERE resolution = ${plan.origen} AND ts >= ${desde} AND ts < ${hasta}
    GROUP BY host_id, bucket, device
    ON CONFLICT (host_id, resolution, ts, device) DO UPDATE SET
      read_bps = EXCLUDED.read_bps, write_bps = EXCLUDED.write_bps,
      read_ops = EXCLUDED.read_ops, write_ops = EXCLUDED.write_ops,
      utilization = EXCLUDED.utilization,
      read_latency_ms = EXCLUDED.read_latency_ms,
      write_latency_ms = EXCLUDED.write_latency_ms,
      sample_count = EXCLUDED.sample_count
    WHERE EXCLUDED.sample_count > disk_metric_samples.sample_count
  `)

  // El filesystem cambia despacio: el último valor del bucket describe mejor
  // "cuánto disco había" que un promedio de cinco minutos.
  const filasFilesystem = await db.execute(sql`
    INSERT INTO filesystem_metric_samples (
      host_id, resolution, ts, mount_point, device, fstype,
      size_bytes, used_bytes, available_bytes, inodes_total, inodes_used, sample_count
    )
    SELECT
      host_id, ${plan.destino}::text, ${bucket} AS bucket, mount_point,
      (array_agg(device ORDER BY ts DESC))[1], (array_agg(fstype ORDER BY ts DESC))[1],
      (array_agg(size_bytes ORDER BY ts DESC))[1], (array_agg(used_bytes ORDER BY ts DESC))[1],
      (array_agg(available_bytes ORDER BY ts DESC))[1],
      (array_agg(inodes_total ORDER BY ts DESC))[1], (array_agg(inodes_used ORDER BY ts DESC))[1],
      sum(sample_count)
    FROM filesystem_metric_samples
    WHERE resolution = ${plan.origen} AND ts >= ${desde} AND ts < ${hasta}
    GROUP BY host_id, bucket, mount_point
    ON CONFLICT (host_id, resolution, ts, mount_point) DO UPDATE SET
      size_bytes = EXCLUDED.size_bytes, used_bytes = EXCLUDED.used_bytes,
      available_bytes = EXCLUDED.available_bytes,
      inodes_total = EXCLUDED.inodes_total, inodes_used = EXCLUDED.inodes_used,
      sample_count = EXCLUDED.sample_count
    WHERE EXCLUDED.sample_count > filesystem_metric_samples.sample_count
  `)

  const filasContenedor = await db.execute(sql`
    INSERT INTO container_metric_samples (
      host_id, container_id, resolution, ts, name, image, state, health,
      cpu_percent, memory_bytes, memory_limit_bytes,
      net_rx_bps, net_tx_bps, block_read_bps, block_write_bps,
      uptime_seconds, restarts, ports, coolify_application, coolify_uuid, sample_count
    )
    SELECT
      host_id, container_id, ${plan.destino}::text, ${bucket} AS bucket,
      max(name), max(image), max(state), max(health),
      avg(cpu_percent), avg(memory_bytes)::bigint, max(memory_limit_bytes),
      avg(net_rx_bps), avg(net_tx_bps), avg(block_read_bps), avg(block_write_bps),
      max(uptime_seconds), max(restarts), '[]'::jsonb,
      max(coolify_application), max(coolify_uuid), sum(sample_count)
    FROM container_metric_samples
    WHERE resolution = ${plan.origen} AND ts >= ${desde} AND ts < ${hasta}
    GROUP BY host_id, container_id, bucket
    ON CONFLICT (host_id, container_id, resolution, ts) DO UPDATE SET
      cpu_percent = EXCLUDED.cpu_percent, memory_bytes = EXCLUDED.memory_bytes,
      memory_limit_bytes = EXCLUDED.memory_limit_bytes,
      net_rx_bps = EXCLUDED.net_rx_bps, net_tx_bps = EXCLUDED.net_tx_bps,
      block_read_bps = EXCLUDED.block_read_bps,
      block_write_bps = EXCLUDED.block_write_bps,
      uptime_seconds = EXCLUDED.uptime_seconds, restarts = EXCLUDED.restarts,
      state = EXCLUDED.state, health = EXCLUDED.health,
      sample_count = EXCLUDED.sample_count
    WHERE EXCLUDED.sample_count > container_metric_samples.sample_count
  `)

  return {
    destino: plan.destino,
    filasHost: filasHost.rowCount ?? 0,
    filasRed: filasRed.rowCount ?? 0,
    filasDisco: filasDisco.rowCount ?? 0,
    filasFilesystem: filasFilesystem.rowCount ?? 0,
    filasContenedor: filasContenedor.rowCount ?? 0,
  }
}

export async function correrTodosLosRollups(
  db: BaseDatos,
  arranque = false,
): Promise<ResultadoRollup[]> {
  const resultados: ResultadoRollup[] = []
  // En orden: 15m se alimenta de lo que acaba de escribir 5m.
  for (const plan of PLANES) {
    resultados.push(await correrRollup(db, plan, arranque))
  }
  return resultados
}
