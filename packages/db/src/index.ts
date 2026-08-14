import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import * as schema from './schema.js'

export * from './schema.js'
export * from './configuracion.js'
export * from './semilla.js'
export * from './alertas.js'
export * from './contrasenias.js'
export * from './clavesApi.js'
export { schema }

/* ============================================================================
 * Conexión a PostgreSQL.
 *
 * Un pool por proceso. Web y collector abren el suyo contra la misma base; no
 * se hablan entre ellos por HTTP, sólo a través de estas tablas y de
 * LISTEN/NOTIFY. Ver docs/architecture.md.
 * ========================================================================== */

const { Pool, types } = pg

/* `bigint` (OID 20) llega como string por defecto para no perder precisión.
 * Nuestros bigint son cuentas de bytes y de segundos, muy por debajo de
 * 2^53, así que convertirlos a number es seguro y evita tener que castear en
 * cada lectura. */
types.setTypeParser(20, (valor: string) => Number.parseInt(valor, 10))

export type BaseDatos = ReturnType<typeof crearBase>

export interface OpcionesConexion {
  url: string
  /** Tamaño máximo del pool. El collector necesita muy poco; web más. */
  maxConexiones?: number
  ssl?: boolean
}

export function crearPool(opciones: OpcionesConexion): pg.Pool {
  const pool = new Pool({
    connectionString: opciones.url,
    max: opciones.maxConexiones ?? 10,
    // Cortamos conexiones ociosas: en una VM chica no tiene sentido sostener
    // diez sockets contra Postgres para un dashboard que casi siempre está
    // esperando el próximo tick.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(opciones.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
  })

  /* Sin este listener, el proceso se MUERE cuando Postgres se reinicia.
   *
   * `pg.Pool` emite `'error'` en los clientes ociosos, y en Node un evento
   * `'error'` sin listener es una excepción no capturada. Probado: al parar el
   * contenedor de Postgres, la base avisa «terminating connection due to
   * administrator command», el pool lo emite y el proceso web se cae entero —
   * la consola quedaba inalcanzable en vez de mostrar el panel de base caída.
   *
   * Con el listener, el cliente roto se descarta y el pool abre uno nuevo en el
   * próximo pedido. Cada consulta individual sigue fallando y devolviendo su
   * error como corresponde; lo que no pasa es que se caiga el proceso. */
  pool.on('error', (causa) => {
    console.error('[base] conexión ociosa perdida:', causa.message)
  })

  return pool
}

export function crearBase(pool: pg.Pool) {
  return drizzle(pool, { schema })
}

export function baseDesdeUrl(opciones: OpcionesConexion): {
  pool: pg.Pool
  db: BaseDatos
} {
  const pool = crearPool(opciones)
  return { pool, db: crearBase(pool) }
}

/* -------------------------------------------------------------------------
 * Canal de tiempo real
 * ---------------------------------------------------------------------- */

/**
 * Canal de NOTIFY por el que el collector avisa que hay muestra nueva.
 *
 * El payload es sólo el `hostId`: el límite de NOTIFY son 8000 bytes y una
 * instantánea con contenedores lo pasa sin esfuerzo. El proceso web escucha,
 * lee `live_snapshots` y empuja por SSE.
 */
export const CANAL_INSTANTANEA = 'vmstats_instantanea'
export const CANAL_DESPLIEGUE = 'vmstats_despliegue'
export const CANAL_ALERTA = 'vmstats_alerta'

/* -------------------------------------------------------------------------
 * Advisory locks
 * ---------------------------------------------------------------------- */

/**
 * Identificadores de los locks de trabajos periódicos.
 *
 * Postgres los toma como un entero de 64 bits; usamos constantes fijas para que
 * dos procesos que arrancan a la vez (o dos réplicas del collector) no corran
 * el mismo rollup dos veces.
 */
export const LOCKS = {
  rollup1m: 811_001,
  rollup5m: 811_005,
  retencion: 811_100,
  evaluacionAlertas: 811_200,
} as const

export type NombreLock = keyof typeof LOCKS

/**
 * Corre `trabajo` sólo si consigue el lock; si otro proceso lo tiene, no hace
 * nada y devuelve `null`.
 *
 * `pg_try_advisory_lock` no espera, que es exactamente lo que queremos: si el
 * rollup anterior sigue corriendo, saltear este tick es mejor que encolar.
 */
export async function conLock<T>(
  pool: pg.Pool,
  nombre: NombreLock,
  trabajo: () => Promise<T>,
): Promise<T | null> {
  const cliente = await pool.connect()
  try {
    const id = LOCKS[nombre]
    const res = await cliente.query<{ obtenido: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS obtenido',
      [id],
    )
    if (res.rows[0]?.obtenido !== true) return null
    try {
      return await trabajo()
    } finally {
      await cliente.query('SELECT pg_advisory_unlock($1)', [id])
    }
  } finally {
    cliente.release()
  }
}

/** Ping barato para los healthchecks. */
export async function baseViva(db: BaseDatos): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`)
    return true
  } catch {
    return false
  }
}
