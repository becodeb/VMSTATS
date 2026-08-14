import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { Capacidades, Presion, Proceso, Puerto, Temperatura } from '@vmstats/shared'

/* ============================================================================
 * Esquema de vmstats.
 *
 * Decisión central: en vez de una tabla por resolución (cruda, 1 minuto, 5
 * minutos) hay una sola tabla por familia de métricas con una columna
 * `resolucion` dentro de la clave primaria.
 *
 * Con esto el rollup es un `INSERT … SELECT … GROUP BY date_bin` sobre la misma
 * tabla, la retención es un `DELETE WHERE resolucion = $1 AND ts < $2`, y las
 * consultas de historial cambian de granularidad sin cambiar de tabla. Tres
 * tablas paralelas habrían triplicado el mismo SQL con distinto nombre.
 *
 * Todas las marcas de tiempo son `timestamptz` en UTC. La zona horaria es una
 * preferencia de visualización y vive en `app_settings`.
 * ========================================================================== */

/** Debe coincidir con `Resolucion` de @vmstats/shared. */
export type Resolucion = 'raw' | '1m' | '5m'

const ts = (nombre: string) => timestamp(nombre, { withTimezone: true, mode: 'date' })
const tsAuto = () => timestamp({ withTimezone: true, mode: 'date' })

/* -------------------------------------------------------------------------
 * Identidad y sesiones
 * ---------------------------------------------------------------------- */

export const usuarios = pgTable(
  'users',
  {
    id: uuid().defaultRandom().primaryKey(),
    email: text().notNull(),
    /** Argon2id, formato PHC. Nunca sale del servidor. */
    hashContrasenia: text('password_hash').notNull(),
    nombre: text('name').notNull(),
    rol: text('role').notNull().default('admin'),
    creadoEn: ts('created_at').notNull().defaultNow(),
    actualizadoEn: ts('updated_at').notNull().defaultNow(),
    deshabilitadoEn: ts('disabled_at'),
  },
  (t) => [uniqueIndex('users_email_idx').on(sql`lower(${t.email})`)],
)

export const sesiones = pgTable(
  'sessions',
  {
    /** SHA-256 del token en hex, NO el token.
     *
     * Si alguien se lleva un dump de la base, no se lleva sesiones usables: el
     * token vive únicamente en la cookie del navegador. Ver docs/security.md. */
    id: text().primaryKey(),
    usuarioId: uuid('user_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    expiraEn: ts('expires_at').notNull(),
    creadaEn: ts('created_at').notNull().defaultNow(),
    usadaEn: ts('last_used_at').notNull().defaultNow(),
    ip: text(),
    agenteUsuario: text('user_agent'),
  },
  (t) => [
    index('sessions_user_idx').on(t.usuarioId),
    index('sessions_expires_idx').on(t.expiraEn),
  ],
)

/**
 * Claves de API para acceso programático.
 *
 * Mismo modelo que `sessions`, y por la misma razón: la columna `id` es el
 * SHA-256 del secreto, no el secreto. El valor completo se muestra una única
 * vez, cuando se crea; después no hay forma de recuperarlo ni desde la base.
 *
 * `prefix` existe para que la lista de claves sea legible —«vmst_8Kd2…»— sin
 * tener que guardar nada sensible: son los primeros caracteres del secreto, que
 * por sí solos no alcanzan para autenticar.
 */
export const clavesApi = pgTable(
  'api_keys',
  {
    id: text().primaryKey(),
    usuarioId: uuid('user_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    nombre: text('name').notNull(),
    prefijo: text('prefix').notNull(),
    /** `read` (sólo GET) o `admin` (también mutaciones). Ver lib/clavesApi.ts. */
    alcance: text('scope').notNull().default('read'),
    creadaEn: ts('created_at').notNull().defaultNow(),
    /** Null = no vence. */
    expiraEn: ts('expires_at'),
    usadaEn: ts('last_used_at'),
    revocadaEn: ts('revoked_at'),
  },
  (t) => [index('api_keys_user_idx').on(t.usuarioId)],
)

/** Rate limiting de login. Se limpia junto con la retención de métricas. */
export const intentosLogin = pgTable(
  'login_attempts',
  {
    id: serial().primaryKey(),
    /** IP o `email:<direccion>`: limitamos por las dos dimensiones para que ni
     *  una IP pueda probar mil usuarios ni mil IPs un solo usuario. */
    clave: text('key').notNull(),
    en: ts('at').notNull().defaultNow(),
    exitoso: boolean('successful').notNull(),
  },
  (t) => [index('login_attempts_key_at_idx').on(t.clave, t.en)],
)

/* -------------------------------------------------------------------------
 * Hosts y latidos
 * ---------------------------------------------------------------------- */

export const hosts = pgTable('hosts', {
  id: text().primaryKey(),
  hostname: text().notNull(),
  kernel: text().notNull(),
  distribucion: text('distro').notNull(),
  arquitectura: text('arch').notNull(),
  nucleos: integer('cores').notNull(),
  vistoPrimeroEn: ts('first_seen').notNull().defaultNow(),
  vistoUltimoEn: ts('last_seen').notNull().defaultNow(),
})

export const latidosCollector = pgTable('collector_heartbeats', {
  hostId: text('host_id')
    .primaryKey()
    .references(() => hosts.id, { onDelete: 'cascade' }),
  vistoEn: ts('last_seen').notNull().defaultNow(),
  version: text().notNull(),
  intervaloMuestreoSegundos: integer('sample_interval_seconds').notNull(),
  /** Qué pudo leer en esta VM: la UI distingue «no disponible acá» de «todavía
   *  no llegó». */
  capacidades: jsonb('capabilities').$type<Capacidades>().notNull(),
})

/* -------------------------------------------------------------------------
 * Métricas del host
 * ---------------------------------------------------------------------- */

export const muestrasHost = pgTable(
  'host_metric_samples',
  {
    hostId: text('host_id').notNull(),
    resolucion: text('resolution').$type<Resolucion>().notNull(),
    ts: tsAuto().notNull(),

    cpuTotal: real('cpu_total').notNull(),
    cpuUser: real('cpu_user').notNull(),
    cpuSystem: real('cpu_system').notNull(),
    cpuNice: real('cpu_nice').notNull(),
    cpuIdle: real('cpu_idle').notNull(),
    cpuIowait: real('cpu_iowait').notNull(),
    cpuIrq: real('cpu_irq').notNull(),
    cpuSoftirq: real('cpu_softirq').notNull(),
    cpuSteal: real('cpu_steal').notNull(),
    cpuPorNucleo: jsonb('cpu_per_core').$type<number[]>().notNull(),

    carga1: real('load_1').notNull(),
    carga5: real('load_5').notNull(),
    carga15: real('load_15').notNull(),
    nucleos: integer('cores').notNull(),

    memTotal: bigint('mem_total', { mode: 'number' }).notNull(),
    memUsada: bigint('mem_used', { mode: 'number' }).notNull(),
    memDisponible: bigint('mem_available', { mode: 'number' }).notNull(),
    memLibre: bigint('mem_free', { mode: 'number' }).notNull(),
    memCache: bigint('mem_cached', { mode: 'number' }).notNull(),
    memBuffers: bigint('mem_buffers', { mode: 'number' }).notNull(),
    swapTotal: bigint('swap_total', { mode: 'number' }).notNull(),
    swapUsada: bigint('swap_used', { mode: 'number' }).notNull(),

    uptimeSegundos: bigint('uptime_seconds', { mode: 'number' }).notNull(),

    /* Agregados de red y disco sobre todas las interfaces y dispositivos. El
     * detalle por interfaz vive en sus tablas; esto es lo que dibuja el
     * Resumen sin tener que agrupar en cada consulta. */
    redRxBps: doublePrecision('net_rx_bps').notNull(),
    redTxBps: doublePrecision('net_tx_bps').notNull(),
    discoLecturaBps: doublePrecision('disk_read_bps').notNull(),
    discoEscrituraBps: doublePrecision('disk_write_bps').notNull(),

    tcpEstablecidas: integer('tcp_established'),
    tcpEscuchando: integer('tcp_listen'),
    tcpTimeWait: integer('tcp_time_wait'),
    tcpTotal: integer('tcp_total'),

    /* PSI: nulo donde el kernel no expone /proc/pressure. */
    psiCpu: real('psi_cpu_some10'),
    psiMemoria: real('psi_mem_some10'),
    psiIo: real('psi_io_some10'),
    presionDetalle: jsonb('pressure_detail').$type<Presion>(),

    /** Top de procesos. Sólo en `raw`: agregar un ranking no tiene sentido. */
    procesos: jsonb('processes').$type<Proceso[]>(),
    temperaturas: jsonb('temperatures').$type<Temperatura[]>(),

    /** Cuántas muestras crudas resume esta fila. 1 en `raw`. */
    muestras: integer('sample_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.hostId, t.resolucion, t.ts] }),
    // Retención y rollup barren por (resolución, tiempo) sin filtrar host.
    index('host_samples_res_ts_idx').on(t.resolucion, t.ts),
  ],
)

export const muestrasFilesystem = pgTable(
  'filesystem_metric_samples',
  {
    hostId: text('host_id').notNull(),
    resolucion: text('resolution').$type<Resolucion>().notNull(),
    ts: tsAuto().notNull(),
    puntoMontaje: text('mount_point').notNull(),
    dispositivo: text('device').notNull(),
    tipo: text('fstype').notNull(),
    tamanio: bigint('size_bytes', { mode: 'number' }).notNull(),
    usado: bigint('used_bytes', { mode: 'number' }).notNull(),
    disponible: bigint('available_bytes', { mode: 'number' }).notNull(),
    inodosTotal: bigint('inodes_total', { mode: 'number' }),
    inodosUsados: bigint('inodes_used', { mode: 'number' }),
    muestras: integer('sample_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.hostId, t.resolucion, t.ts, t.puntoMontaje] }),
    index('fs_samples_res_ts_idx').on(t.resolucion, t.ts),
  ],
)

export const muestrasRed = pgTable(
  'network_metric_samples',
  {
    hostId: text('host_id').notNull(),
    resolucion: text('resolution').$type<Resolucion>().notNull(),
    ts: tsAuto().notNull(),
    interfaz: text('interface').notNull(),
    rxBps: doublePrecision('rx_bps').notNull(),
    txBps: doublePrecision('tx_bps').notNull(),
    rxPps: doublePrecision('rx_pps').notNull(),
    txPps: doublePrecision('tx_pps').notNull(),
    rxErrores: bigint('rx_errors', { mode: 'number' }).notNull(),
    txErrores: bigint('tx_errors', { mode: 'number' }).notNull(),
    rxDescartes: bigint('rx_drops', { mode: 'number' }).notNull(),
    txDescartes: bigint('tx_drops', { mode: 'number' }).notNull(),
    muestras: integer('sample_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.hostId, t.resolucion, t.ts, t.interfaz] }),
    index('net_samples_res_ts_idx').on(t.resolucion, t.ts),
  ],
)

export const muestrasDisco = pgTable(
  'disk_metric_samples',
  {
    hostId: text('host_id').notNull(),
    resolucion: text('resolution').$type<Resolucion>().notNull(),
    ts: tsAuto().notNull(),
    dispositivo: text('device').notNull(),
    lecturaBps: doublePrecision('read_bps').notNull(),
    escrituraBps: doublePrecision('write_bps').notNull(),
    lecturaOps: doublePrecision('read_ops').notNull(),
    escrituraOps: doublePrecision('write_ops').notNull(),
    utilizacion: real('utilization'),
    latenciaLecturaMs: real('read_latency_ms'),
    latenciaEscrituraMs: real('write_latency_ms'),
    muestras: integer('sample_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.hostId, t.resolucion, t.ts, t.dispositivo] }),
    index('disk_samples_res_ts_idx').on(t.resolucion, t.ts),
  ],
)

export const muestrasContenedor = pgTable(
  'container_metric_samples',
  {
    hostId: text('host_id').notNull(),
    contenedorId: text('container_id').notNull(),
    resolucion: text('resolution').$type<Resolucion>().notNull(),
    ts: tsAuto().notNull(),
    nombre: text('name').notNull(),
    imagen: text('image').notNull(),
    estado: text('state').notNull(),
    salud: text('health').notNull(),
    cpuPorcentaje: real('cpu_percent').notNull(),
    memoriaBytes: bigint('memory_bytes', { mode: 'number' }).notNull(),
    memoriaLimiteBytes: bigint('memory_limit_bytes', { mode: 'number' }),
    redRxBps: doublePrecision('net_rx_bps').notNull(),
    redTxBps: doublePrecision('net_tx_bps').notNull(),
    bloqueLecturaBps: doublePrecision('block_read_bps').notNull(),
    bloqueEscrituraBps: doublePrecision('block_write_bps').notNull(),
    uptimeSegundos: bigint('uptime_seconds', { mode: 'number' }).notNull(),
    reinicios: integer('restarts').notNull(),
    puertos: jsonb('ports').$type<Puerto[]>().notNull(),
    coolifyAplicacion: text('coolify_application'),
    coolifyUuid: text('coolify_uuid'),
    muestras: integer('sample_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.hostId, t.contenedorId, t.resolucion, t.ts] }),
    index('container_samples_res_ts_idx').on(t.resolucion, t.ts),
    index('container_samples_ts_idx').on(t.ts),
  ],
)

/**
 * La foto más reciente de cada host, una fila por host.
 *
 * Es lo que el proceso web lee cuando llega un `NOTIFY` y lo que empuja por
 * SSE. Vive en la base en vez de en memoria del collector para que web y
 * collector no necesiten hablarse: Postgres es el único bus entre los dos, así
 * el collector no expone ningún puerto.
 */
export const instantaneas = pgTable('live_snapshots', {
  hostId: text('host_id').primaryKey(),
  actualizadaEn: ts('updated_at').notNull().defaultNow(),
  contenido: jsonb('payload').notNull(),
})

/* -------------------------------------------------------------------------
 * Despliegues
 * ---------------------------------------------------------------------- */

export const eventosDespliegue = pgTable(
  'deployment_events',
  {
    id: serial().primaryKey(),
    despliegueUuid: text('deployment_uuid').notNull(),
    estado: text('status').notNull(),
    estadoAnterior: text('previous_status'),
    observadoEn: ts('observed_at').notNull().defaultNow(),
    aplicacionUuid: text('application_uuid'),
    aplicacionNombre: text('application_name'),
    rama: text('branch'),
    commit: text('commit_sha'),
    commitMensaje: text('commit_message'),
    iniciadoEn: ts('started_at'),
    finalizadoEn: ts('finished_at'),
    duracionSegundos: integer('duration_seconds'),
    url: text(),
  },
  (t) => [
    /* Idempotencia entre reinicios del collector.
     *
     * El collector reencuentra los mismos despliegues después de un reinicio y
     * volvería a registrar «in_progress» para uno que ya venía siguiendo. Con
     * esta única, el `ON CONFLICT DO NOTHING` del insert lo descarta: cada par
     * (despliegue, estado) se guarda una sola vez, para siempre. */
    uniqueIndex('deployment_events_uuid_status_idx').on(t.despliegueUuid, t.estado),
    index('deployment_events_observed_idx').on(t.observadoEn),
    index('deployment_events_uuid_idx').on(t.despliegueUuid),
  ],
)

/* -------------------------------------------------------------------------
 * Alertas
 * ---------------------------------------------------------------------- */

export const reglasAlerta = pgTable(
  'alert_rules',
  {
  id: serial().primaryKey(),
  nombre: text('name').notNull(),
  metrica: text('metric').notNull(),
  operador: text('operator').notNull(),
  umbral: doublePrecision('threshold').notNull(),
  severidad: text('severity').notNull(),
  duracionMinimaSegundos: integer('min_duration_seconds').notNull().default(60),
  cooldownSegundos: integer('cooldown_seconds').notNull().default(300),
  histeresis: doublePrecision('hysteresis').notNull().default(0),
  habilitada: boolean('enabled').notNull().default(true),
  silenciadaHasta: ts('silenced_until'),
  creadaEn: ts('created_at').notNull().defaultNow(),
  actualizadaEn: ts('updated_at').notNull().defaultNow(),
  },
  /* El nombre es único para que la semilla pueda usar `ON CONFLICT DO NOTHING`.
   * Sin esto, cada corrida de las migraciones duplicaría las once reglas
   * iniciales y el operador vería la misma alerta once veces. */
  (t) => [uniqueIndex('alert_rules_name_idx').on(t.nombre)],
)

/**
 * Estado de la máquina de evaluación, persistido.
 *
 * Sin esto, un reinicio del collector reinicia el reloj de la duración mínima y
 * una condición que ya llevaba diez minutos vuelve a empezar de cero.
 */
export const estadoReglaAlerta = pgTable('alert_rule_state', {
  reglaId: integer('rule_id')
    .primaryKey()
    .references(() => reglasAlerta.id, { onDelete: 'cascade' }),
  condicionDesde: ts('condition_since'),
  activaDesde: ts('active_since'),
  ultimaResolucion: ts('last_resolution'),
})

export const instanciasAlerta = pgTable(
  'alert_instances',
  {
    id: serial().primaryKey(),
    reglaId: integer('rule_id')
      .notNull()
      .references(() => reglasAlerta.id, { onDelete: 'cascade' }),
    estado: text('state').notNull().default('activa'),
    valorDisparo: doublePrecision('trigger_value').notNull(),
    umbral: doublePrecision('threshold').notNull(),
    severidad: text('severity').notNull(),
    iniciadaEn: ts('started_at').notNull().defaultNow(),
    resueltaEn: ts('resolved_at'),
    reconocidaEn: ts('acknowledged_at'),
    reconocidaPor: uuid('acknowledged_by').references(() => usuarios.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('alert_instances_state_idx').on(t.estado, t.iniciadaEn),
    index('alert_instances_rule_idx').on(t.reglaId),
    /* Una sola alerta abierta por regla. Es la última línea de defensa contra
     * duplicados si dos evaluaciones se pisan; el índice parcial deja pasar
     * todas las resueltas. */
    uniqueIndex('alert_instances_una_abierta_idx')
      .on(t.reglaId)
      .where(sql`${t.estado} <> 'resuelta'`),
  ],
)

/* -------------------------------------------------------------------------
 * Configuración y auditoría
 * ---------------------------------------------------------------------- */

export const configuracion = pgTable('app_settings', {
  clave: text('key').primaryKey(),
  valor: jsonb('value').notNull(),
  actualizadaEn: ts('updated_at').notNull().defaultNow(),
})

export const auditoria = pgTable(
  'audit_log',
  {
    id: serial().primaryKey(),
    en: ts('at').notNull().defaultNow(),
    usuarioId: uuid('user_id').references(() => usuarios.id, { onDelete: 'set null' }),
    /** Se guarda además del id: si el usuario se borra, el rastro sobrevive. */
    usuarioEmail: text('user_email'),
    accion: text('action').notNull(),
    objetivo: text('target'),
    detalle: jsonb('detail'),
    ip: text(),
  },
  (t) => [index('audit_log_at_idx').on(t.en), index('audit_log_user_idx').on(t.usuarioId)],
)

export const tablas = {
  usuarios,
  sesiones,
  clavesApi,
  intentosLogin,
  hosts,
  latidosCollector,
  muestrasHost,
  muestrasFilesystem,
  muestrasRed,
  muestrasDisco,
  muestrasContenedor,
  instantaneas,
  eventosDespliegue,
  reglasAlerta,
  estadoReglaAlerta,
  instanciasAlerta,
  configuracion,
  auditoria,
}
