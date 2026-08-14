import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import {
  baseDesdeUrl,
  conLock,
  evaluarCiclo,
  leerPreferencias,
  guardarPreferencias,
  type BaseDatos,
} from '@vmstats/db'
import { correrRetencion } from '../apps/collector/src/trabajos/retencion.js'
import { correrTodosLosRollups } from '../apps/collector/src/trabajos/rollup.js'
import {
  guardarMuestraHost,
  guardarTransiciones,
  publicarInstantanea,
  registrarHost,
  registrarLatido,
} from '../apps/collector/src/persistencia.js'
import { muestraDePrueba } from './fixtures/muestra.js'

/* ============================================================================
 * Tests de integración contra PostgreSQL.
 *
 * Codifican las tres promesas del sistema que sólo se pueden verificar contra
 * una base de verdad, y que la spec lista como criterios de salida:
 *
 *   - el rollup es idempotente y correcto,
 *   - el collector puede reiniciarse sin duplicar eventos de despliegue,
 *   - la retención borra lo viejo y nada más.
 *
 * Se saltean solos sin `DATABASE_URL`: un `npm test` en una máquina sin base
 * tiene que decir «no probé esto», no «está roto».
 * ========================================================================== */

const URL_BASE = process.env['DATABASE_URL'] ?? ''
const hayBase = URL_BASE.length > 0

/** Prefijo propio para no pisar datos de una instancia real. */
const HOST = 'test-integracion'

let pool: pg.Pool
let db: BaseDatos

/** Una transición de despliegue lista para persistir. */
function transicion(uuid: string, estado: string) {
  return {
    estadoAnterior: null,
    despliegue: {
      uuid,
      aplicacionUuid: 'app',
      aplicacionNombre: 'tienda',
      estado: estado as 'queued',
      rama: 'main',
      commit: 'abc1234',
      commitMensaje: 'cambio',
      iniciadoEn: new Date('2026-01-01T10:00:00Z').toISOString(),
      finalizadoEn: null,
      duracionSegundos: null,
      url: null,
    },
  }
}

describe.skipIf(!hayBase)('integración con PostgreSQL', () => {
  beforeAll(async () => {
    const conexion = baseDesdeUrl({ url: URL_BASE, maxConexiones: 4 })
    pool = conexion.pool
    db = conexion.db
    await limpiar()
  })

  afterAll(async () => {
    if (pool !== undefined) {
      await limpiar()
      await pool.end()
    }
  })

  async function limpiar(): Promise<void> {
    await db.execute(sql`DELETE FROM host_metric_samples WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM filesystem_metric_samples WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM network_metric_samples WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM disk_metric_samples WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM container_metric_samples WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM live_snapshots WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM collector_heartbeats WHERE host_id = ${HOST}`)
    await db.execute(sql`DELETE FROM hosts WHERE id = ${HOST}`)
    await db.execute(sql`DELETE FROM deployment_events WHERE deployment_uuid LIKE 'test-%'`)
  }

  /* --- Persistencia --------------------------------------------------- */

  it('guarda una muestra completa y la deja legible', async () => {
    const muestra = muestraDePrueba({ hostId: HOST })
    await registrarHost(db, muestra)
    await guardarMuestraHost(db, muestra)

    const filas = await db.execute<{ cpu_total: number; mem_used: number }>(sql`
      SELECT cpu_total, mem_used FROM host_metric_samples
      WHERE host_id = ${HOST} AND resolution = 'raw'
    `)

    expect(filas.rows).toHaveLength(1)
    expect(filas.rows[0]?.cpu_total).toBeCloseTo(35.5, 3)
    // El redondeo a bigint pasó: sin él, PostgreSQL rechaza el decimal.
    expect(Number.isInteger(filas.rows[0]?.mem_used)).toBe(true)
  })

  it('acepta valores fraccionarios en columnas bigint', async () => {
    // Es el bug que apareció en la primera corrida real: la fuente produce
    // memoria con decimales y la columna es bigint.
    const muestra = muestraDePrueba({
      hostId: HOST,
      ts: new Date('2026-01-01T00:00:30Z').toISOString(),
      memoria: { usada: 10_614_178_464.630344, total: 17_179_869_184 },
      uptimeSegundos: 1234.5678,
    })

    await expect(guardarMuestraHost(db, muestra)).resolves.toBeUndefined()
  })

  it('no duplica al reinsertar la misma muestra', async () => {
    const muestra = muestraDePrueba({
      hostId: HOST,
      ts: new Date('2026-01-01T00:01:00Z').toISOString(),
    })
    await guardarMuestraHost(db, muestra)
    await guardarMuestraHost(db, muestra)

    const filas = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM host_metric_samples
      WHERE host_id = ${HOST} AND ts = ${new Date('2026-01-01T00:01:00Z')}
    `)
    expect(filas.rows[0]?.n).toBe(1)
  })

  /* --- Rollup ---------------------------------------------------------- */

  describe('rollup', () => {
    beforeAll(async () => {
      await db.execute(sql`DELETE FROM host_metric_samples WHERE host_id = ${HOST}`)

      // 30 minutos de muestras cada 10 s con una rampa conocida de CPU.
      await db.execute(sql`
        INSERT INTO host_metric_samples (
          host_id, resolution, ts, cpu_total, cpu_user, cpu_system, cpu_nice, cpu_idle,
          cpu_iowait, cpu_irq, cpu_softirq, cpu_steal, cpu_per_core,
          load_1, load_5, load_15, cores, mem_total, mem_used, mem_available, mem_free,
          mem_cached, mem_buffers, swap_total, swap_used, uptime_seconds,
          net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps, sample_count
        )
        SELECT ${HOST}, 'raw', now() - (n || ' seconds')::interval,
               (n % 100)::real, 1, 1, 0, 50, 1, 0, 0, 0, '[]'::jsonb,
               0.5, 0.5, 0.5, 4, 1000, 500, 500, 200, 200, 100, 0, 0, 1000,
               100, 200, 300, 400, 1
        FROM generate_series(20, 1800, 10) AS n
      `)
    })

    it('agrega los crudos a buckets de un minuto y de cinco', async () => {
      await correrTodosLosRollups(db)

      const filas = await db.execute<{ resolution: string; buckets: number }>(sql`
        SELECT resolution, count(*)::int AS buckets
        FROM host_metric_samples WHERE host_id = ${HOST}
        GROUP BY resolution
      `)

      const porResolucion = new Map(filas.rows.map((f) => [f.resolution, f.buckets]))
      expect(porResolucion.get('1m') ?? 0).toBeGreaterThan(20)
      expect(porResolucion.get('5m') ?? 0).toBeGreaterThan(3)
    })

    it('el promedio del bucket es el de sus muestras', async () => {
      const filas = await db.execute<{ agregado: number; esperado: number }>(sql`
        SELECT h.cpu_total AS agregado, avg(r.cpu_total) AS esperado
        FROM host_metric_samples h
        JOIN host_metric_samples r
          ON r.resolution = 'raw' AND r.host_id = h.host_id
         AND r.ts >= h.ts AND r.ts < h.ts + interval '1 minute'
        WHERE h.resolution = '1m' AND h.host_id = ${HOST}
        GROUP BY h.ts, h.cpu_total
        LIMIT 5
      `)

      expect(filas.rows.length).toBeGreaterThan(0)
      for (const fila of filas.rows) {
        expect(Number(fila.agregado)).toBeCloseTo(Number(fila.esperado), 3)
      }
    })

    it('correrlo de nuevo no cambia nada', async () => {
      const contar = async () => {
        const r = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM host_metric_samples
          WHERE host_id = ${HOST} AND resolution <> 'raw'
        `)
        return r.rows[0]?.n ?? 0
      }

      const antes = await contar()
      await correrTodosLosRollups(db)
      await correrTodosLosRollups(db)
      expect(await contar()).toBe(antes)
    })

    it('no agrega el bucket que todavía se está llenando', async () => {
      // Un bucket incompleto guardado nunca se corrige, y quedaría un promedio
      // calculado sobre dos muestras.
      const r = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM host_metric_samples
        WHERE host_id = ${HOST} AND resolution = '1m'
          AND ts >= date_bin(interval '1 minute', now(), timestamptz '2000-01-01')
      `)
      expect(r.rows[0]?.n).toBe(0)
    })
  })

  /* --- Despliegues ----------------------------------------------------- */

  describe('idempotencia de los despliegues', () => {
    it('guarda cada transición una sola vez', async () => {
      expect(await guardarTransiciones(db, [transicion('test-1', 'queued')])).toBe(1)
      // El collector reinicia y vuelve a ver el mismo despliegue en el mismo
      // estado: el índice único lo descarta.
      expect(await guardarTransiciones(db, [transicion('test-1', 'queued')])).toBe(0)
      expect(await guardarTransiciones(db, [transicion('test-1', 'queued')])).toBe(0)
    })

    it('sí guarda el cambio a otro estado', async () => {
      expect(await guardarTransiciones(db, [transicion('test-1', 'in_progress')])).toBe(1)
      expect(await guardarTransiciones(db, [transicion('test-1', 'finished')])).toBe(1)

      const r = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM deployment_events WHERE deployment_uuid = 'test-1'
      `)
      expect(r.rows[0]?.n).toBe(3)
    })

    it('sobrevive a un lote con duplicados adentro', async () => {
      const guardadas = await guardarTransiciones(db, [
        transicion('test-2', 'queued'),
        transicion('test-2', 'queued'),
      ])
      expect(guardadas).toBeLessThanOrEqual(1)
    })
  })

  /* --- Retención -------------------------------------------------------- */

  it('la retención borra lo viejo y respeta lo reciente', async () => {
    await db.execute(sql`DELETE FROM host_metric_samples WHERE host_id = ${HOST}`)

    // Una muestra de hace 30 días y otra de recién.
    for (const dias of [30, 0]) {
      await db.execute(sql`
        INSERT INTO host_metric_samples (
          host_id, resolution, ts, cpu_total, cpu_user, cpu_system, cpu_nice, cpu_idle,
          cpu_iowait, cpu_irq, cpu_softirq, cpu_steal, cpu_per_core,
          load_1, load_5, load_15, cores, mem_total, mem_used, mem_available, mem_free,
          mem_cached, mem_buffers, swap_total, swap_used, uptime_seconds,
          net_rx_bps, net_tx_bps, disk_read_bps, disk_write_bps, sample_count
        ) VALUES (
          ${HOST}, 'raw', now() - (${dias} || ' days')::interval,
          10, 1, 1, 0, 90, 0, 0, 0, 0, '[]'::jsonb,
          0.5, 0.5, 0.5, 4, 1000, 500, 500, 200, 200, 100, 0, 0, 1000,
          0, 0, 0, 0, 1
        )
      `)
    }

    const preferencias = await leerPreferencias(db)
    await correrRetencion(db, { ...preferencias, retencionRawDias: 7 })

    const r = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM host_metric_samples
      WHERE host_id = ${HOST} AND resolution = 'raw'
    `)
    expect(r.rows[0]?.n).toBe(1)
  })

  /* --- Locks, instantánea y alertas -------------------------------------- */

  it('el advisory lock excluye a un segundo proceso', async () => {
    /* Se prueba de forma determinista en vez de lanzar tres en paralelo y
     * mirar quién gana: el resultado de una carrera depende del pool y del
     * scheduler, y un test intermitente es peor que ninguno.
     *
     * La barrera hace que el segundo intento ocurra con el lock tomado, sin
     * depender de cuánto tarde nada. */
    const barrera = Promise.withResolvers<void>()
    let segundo: string | null = 'no corrió'

    const primero = conLock(pool, 'rollup1m', async () => {
      // Con el lock en la mano, un segundo intento tiene que rebotar.
      segundo = await conLock(pool, 'rollup1m', async () => 'no debería entrar')
      barrera.resolve()
      await barrera.promise
      return 'listo'
    })

    expect(await primero).toBe('listo')
    // `null` y no una espera: si el rollup anterior sigue corriendo, saltear
    // este tick es mejor que encolar.
    expect(segundo).toBeNull()

    // Y una vez liberado, el siguiente vuelve a conseguirlo.
    expect(await conLock(pool, 'rollup1m', async () => 'de nuevo')).toBe('de nuevo')
  })

  it('publica la instantánea con una sola fila por host', async () => {
    const muestra = muestraDePrueba({ hostId: HOST })
    const entrada = {
      host: muestra,
      contenedores: [],
      desplieguesActivos: [],
      alertasAbiertas: [],
    }

    await registrarHost(db, muestra)
    await publicarInstantanea(db, entrada)
    await publicarInstantanea(db, entrada)

    const r = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM live_snapshots WHERE host_id = ${HOST}
    `)
    expect(r.rows[0]?.n).toBe(1)
  })

  it('el latido registra las capacidades del host', async () => {
    const muestra = muestraDePrueba({ hostId: HOST })
    await registrarHost(db, muestra)
    await registrarLatido(db, muestra, '0.1.0-test', 5)

    const r = await db.execute<{ capabilities: { presion: boolean } }>(sql`
      SELECT capabilities FROM collector_heartbeats WHERE host_id = ${HOST}
    `)
    expect(r.rows[0]?.capabilities.presion).toBe(true)
  })

  it('las preferencias se leen tal como se guardaron', async () => {
    const originales = await leerPreferencias(db)
    try {
      const nuevas = await guardarPreferencias(db, { zonaHoraria: 'UTC', retencionRawDias: 3 })
      expect(nuevas.zonaHoraria).toBe('UTC')
      expect(nuevas.retencionRawDias).toBe(3)
      // Los campos no tocados sobreviven.
      expect(nuevas.retencionCincoMinutosDias).toBe(originales.retencionCincoMinutosDias)
    } finally {
      await guardarPreferencias(db, originales)
    }
  })

  it('evaluar alertas no abre nada con una muestra sana', async () => {
    const resultado = await evaluarCiclo(db, {
      host: muestraDePrueba({ hostId: HOST, cpu: { total: 5 } }),
      contenedores: [],
      silencioSegundos: 0,
    })
    expect(resultado.nuevas).toBe(0)
  })
})
