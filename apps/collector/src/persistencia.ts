import { sql } from 'drizzle-orm'
import { esquemaInstantanea } from '@vmstats/shared'
import type {
  Despliegue,
  InstanciaAlerta,
  Instantanea,
  MuestraContenedor,
  MuestraHost,
} from '@vmstats/shared'
import {
  CANAL_DESPLIEGUE,
  CANAL_INSTANTANEA,
  eventosDespliegue,
  hosts,
  instantaneas,
  latidosCollector,
  muestrasContenedor,
  muestrasDisco,
  muestrasFilesystem,
  muestrasHost,
  muestrasRed,
  type BaseDatos,
} from '@vmstats/db'
import type { Transicion } from './coolify/seguimiento.js'

/* ============================================================================
 * Escritura a PostgreSQL.
 *
 * Todo lo que persiste el collector pasa por acá. Dos reglas:
 *
 *  - Las muestras se escriben con `ON CONFLICT DO NOTHING`. Dos collectors
 *    corriendo por error, o un reintento después de un timeout, no duplican ni
 *    revientan: la clave primaria (host, resolución, ts) ya dice qué es único.
 *
 *  - La instantánea en vivo y el NOTIFY van juntos. El NOTIFY sólo lleva el
 *    hostId; el proceso web lee la fila. Ver docs/architecture.md.
 * ========================================================================== */

export async function registrarHost(db: BaseDatos, muestra: MuestraHost): Promise<void> {
  await db
    .insert(hosts)
    .values({
      id: muestra.hostId,
      hostname: muestra.sistema.hostname,
      kernel: muestra.sistema.kernel,
      distribucion: muestra.sistema.distribucion,
      arquitectura: muestra.sistema.arquitectura,
      nucleos: muestra.sistema.nucleos,
    })
    .onConflictDoUpdate({
      target: hosts.id,
      set: {
        hostname: muestra.sistema.hostname,
        kernel: muestra.sistema.kernel,
        distribucion: muestra.sistema.distribucion,
        nucleos: muestra.sistema.nucleos,
        vistoUltimoEn: new Date(),
      },
    })
}

export async function registrarLatido(
  db: BaseDatos,
  muestra: MuestraHost,
  version: string,
  intervaloSegundos: number,
): Promise<void> {
  await db
    .insert(latidosCollector)
    .values({
      hostId: muestra.hostId,
      version,
      intervaloMuestreoSegundos: intervaloSegundos,
      capacidades: muestra.capacidades,
      vistoEn: new Date(),
    })
    .onConflictDoUpdate({
      target: latidosCollector.hostId,
      set: {
        vistoEn: new Date(),
        version,
        intervaloMuestreoSegundos: intervaloSegundos,
        capacidades: muestra.capacidades,
      },
    })
}

/**
 * Redondea para las columnas `bigint`.
 *
 * PostgreSQL rechaza un decimal en un bigint con `invalid input syntax`, y las
 * fuentes producen fracciones sin problema: una memoria promediada, un uptime
 * con decimales. Redondear acá —en la frontera donde se conoce el tipo de la
 * columna— evita tener que acordarse en cada fuente.
 *
 * También descarta NaN e Infinity: una división por cero aguas arriba no puede
 * llegar a la base como texto inválido.
 */
function entero(valor: number): number {
  return Number.isFinite(valor) ? Math.round(valor) : 0
}

function enteroOpcional(valor: number | null): number | null {
  return valor === null ? null : entero(valor)
}

/** Suma de todas las interfaces / dispositivos, para los gráficos del Resumen. */
function agregados(muestra: MuestraHost): {
  redRx: number
  redTx: number
  discoLectura: number
  discoEscritura: number
} {
  let redRx = 0
  let redTx = 0
  for (const interfaz of muestra.red) {
    redRx += interfaz.rxBytesPorSeg
    redTx += interfaz.txBytesPorSeg
  }

  let discoLectura = 0
  let discoEscritura = 0
  for (const disco of muestra.discos) {
    discoLectura += disco.lecturaBytesPorSeg
    discoEscritura += disco.escrituraBytesPorSeg
  }

  return { redRx, redTx, discoLectura, discoEscritura }
}

export async function guardarMuestraHost(db: BaseDatos, muestra: MuestraHost): Promise<void> {
  const ts = new Date(muestra.ts)
  const agg = agregados(muestra)

  await db
    .insert(muestrasHost)
    .values({
      hostId: muestra.hostId,
      resolucion: 'raw',
      ts,
      cpuTotal: muestra.cpu.total,
      cpuUser: muestra.cpu.user,
      cpuSystem: muestra.cpu.system,
      cpuNice: muestra.cpu.nice,
      cpuIdle: muestra.cpu.idle,
      cpuIowait: muestra.cpu.iowait,
      cpuIrq: muestra.cpu.irq,
      cpuSoftirq: muestra.cpu.softirq,
      cpuSteal: muestra.cpu.steal,
      cpuPorNucleo: muestra.cpu.porNucleo,
      carga1: muestra.carga.uno,
      carga5: muestra.carga.cinco,
      carga15: muestra.carga.quince,
      nucleos: muestra.carga.nucleos,
      memTotal: entero(muestra.memoria.total),
      memUsada: entero(muestra.memoria.usada),
      memDisponible: entero(muestra.memoria.disponible),
      memLibre: entero(muestra.memoria.libre),
      memCache: entero(muestra.memoria.cache),
      memBuffers: entero(muestra.memoria.buffers),
      swapTotal: entero(muestra.memoria.swapTotal),
      swapUsada: entero(muestra.memoria.swapUsada),
      uptimeSegundos: entero(muestra.uptimeSegundos),
      redRxBps: agg.redRx,
      redTxBps: agg.redTx,
      discoLecturaBps: agg.discoLectura,
      discoEscrituraBps: agg.discoEscritura,
      tcpEstablecidas: muestra.tcp?.establecidas ?? null,
      tcpEscuchando: muestra.tcp?.escuchando ?? null,
      tcpTimeWait: muestra.tcp?.timeWait ?? null,
      tcpTotal: muestra.tcp?.total ?? null,
      psiCpu: muestra.presion.cpu?.some10 ?? null,
      psiMemoria: muestra.presion.memoria?.some10 ?? null,
      psiIo: muestra.presion.io?.some10 ?? null,
      presionDetalle: muestra.presion,
      procesos: muestra.procesos,
      temperaturas: muestra.temperaturas,
      muestras: 1,
    })
    .onConflictDoNothing()

  await guardarFilesystems(db, muestra, ts)
  await guardarRed(db, muestra, ts)
  await guardarDiscos(db, muestra, ts)
}

async function guardarFilesystems(
  db: BaseDatos,
  muestra: MuestraHost,
  ts: Date,
): Promise<void> {
  if (muestra.filesystems.length === 0) return

  await db
    .insert(muestrasFilesystem)
    .values(
      muestra.filesystems.map((fs) => ({
        hostId: muestra.hostId,
        resolucion: 'raw' as const,
        ts,
        puntoMontaje: fs.puntoMontaje,
        dispositivo: fs.dispositivo,
        tipo: fs.tipo,
        tamanio: entero(fs.tamanio),
        usado: entero(fs.usado),
        disponible: entero(fs.disponible),
        inodosTotal: enteroOpcional(fs.inodosTotal),
        inodosUsados: enteroOpcional(fs.inodosUsados),
        muestras: 1,
      })),
    )
    .onConflictDoNothing()
}

async function guardarRed(db: BaseDatos, muestra: MuestraHost, ts: Date): Promise<void> {
  if (muestra.red.length === 0) return

  await db
    .insert(muestrasRed)
    .values(
      muestra.red.map((r) => ({
        hostId: muestra.hostId,
        resolucion: 'raw' as const,
        ts,
        interfaz: r.interfaz,
        rxBps: r.rxBytesPorSeg,
        txBps: r.txBytesPorSeg,
        rxPps: r.rxPaquetesPorSeg,
        txPps: r.txPaquetesPorSeg,
        rxErrores: entero(r.rxErrores),
        txErrores: entero(r.txErrores),
        rxDescartes: entero(r.rxDescartes),
        txDescartes: entero(r.txDescartes),
        muestras: 1,
      })),
    )
    .onConflictDoNothing()
}

async function guardarDiscos(db: BaseDatos, muestra: MuestraHost, ts: Date): Promise<void> {
  if (muestra.discos.length === 0) return

  await db
    .insert(muestrasDisco)
    .values(
      muestra.discos.map((d) => ({
        hostId: muestra.hostId,
        resolucion: 'raw' as const,
        ts,
        dispositivo: d.dispositivo,
        lecturaBps: d.lecturaBytesPorSeg,
        escrituraBps: d.escrituraBytesPorSeg,
        lecturaOps: d.lecturaOpsPorSeg,
        escrituraOps: d.escrituraOpsPorSeg,
        utilizacion: d.utilizacion,
        latenciaLecturaMs: d.latenciaLecturaMs,
        latenciaEscrituraMs: d.latenciaEscrituraMs,
        muestras: 1,
      })),
    )
    .onConflictDoNothing()
}

export async function guardarContenedores(
  db: BaseDatos,
  contenedores: readonly MuestraContenedor[],
): Promise<void> {
  if (contenedores.length === 0) return

  await db
    .insert(muestrasContenedor)
    .values(
      contenedores.map((c) => ({
        hostId: c.hostId,
        contenedorId: c.contenedorId,
        resolucion: 'raw' as const,
        ts: new Date(c.ts),
        nombre: c.nombre,
        imagen: c.imagen,
        estado: c.estado,
        salud: c.salud,
        cpuPorcentaje: c.cpuPorcentaje,
        memoriaBytes: entero(c.memoriaBytes),
        memoriaLimiteBytes:
          enteroOpcional(c.memoriaLimiteBytes),
        redRxBps: c.redRxBytesPorSeg,
        redTxBps: c.redTxBytesPorSeg,
        bloqueLecturaBps: c.bloqueLecturaBytesPorSeg,
        bloqueEscrituraBps: c.bloqueEscrituraBytesPorSeg,
        uptimeSegundos: entero(c.uptimeSegundos),
        reinicios: entero(c.reinicios),
        puertos: c.puertos,
        coolifyAplicacion: c.coolifyAplicacion,
        coolifyUuid: c.coolifyUuid,
        muestras: 1,
      })),
    )
    .onConflictDoNothing()
}

/* -------------------------------------------------------------------------
 * Tiempo real
 * ---------------------------------------------------------------------- */

export interface EntradaInstantanea {
  host: MuestraHost
  contenedores: readonly MuestraContenedor[]
  desplieguesActivos: readonly Despliegue[]
  alertasAbiertas: readonly InstanciaAlerta[]
}

/**
 * Publica la foto actual y avisa por NOTIFY.
 *
 * El upsert deja una sola fila por host: no queremos que la tabla de tiempo
 * real crezca. El NOTIFY va con el hostId solo porque el límite del canal son
 * 8000 bytes y una instantánea con treinta contenedores lo pasa cómodamente.
 */
export async function publicarInstantanea(
  db: BaseDatos,
  entrada: EntradaInstantanea,
): Promise<void> {
  const contenido: Instantanea = {
    host: entrada.host,
    contenedores: [...entrada.contenedores],
    desplieguesActivos: [...entrada.desplieguesActivos],
    alertasAbiertas: [...entrada.alertasAbiertas],
    generadoEn: new Date().toISOString(),
    ultimoLatido: entrada.host.ts,
  }

  /* Se valida ANTES de publicar.
   *
   * El proceso web descarta las instantáneas que no pasan el esquema, así que
   * una sola métrica fuera de rango deja la consola en «el collector todavía no
   * reportó», sin ninguna pista de por qué. Pasó de verdad: un filesystem
   * reportaba más inodos libres que totales y la resta daba negativo.
   *
   * Validando acá, el problema aparece en el log del collector con el campo
   * exacto, que es donde alguien lo puede arreglar. */
  const validada = esquemaInstantanea.safeParse(contenido)
  if (!validada.success) {
    const detalle = validada.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`La instantánea no pasa su propio esquema — ${detalle}`)
  }

  await db
    .insert(instantaneas)
    .values({ hostId: entrada.host.hostId, contenido, actualizadaEn: new Date() })
    .onConflictDoUpdate({
      target: instantaneas.hostId,
      set: { contenido, actualizadaEn: new Date() },
    })

  await db.execute(sql`SELECT pg_notify(${CANAL_INSTANTANEA}, ${entrada.host.hostId})`)
}

/* -------------------------------------------------------------------------
 * Despliegues
 * ---------------------------------------------------------------------- */

/**
 * Guarda transiciones de estado, una sola vez cada una.
 *
 * La idempotencia la impone el índice único `(deployment_uuid, status)`: si el
 * collector reinicia y vuelve a ver un despliegue que ya venía siguiendo, el
 * `ON CONFLICT DO NOTHING` descarta el duplicado sin que el código tenga que
 * acordarse de nada. Es la única defensa que sobrevive a un reinicio.
 */
export async function guardarTransiciones(
  db: BaseDatos,
  transiciones: readonly Transicion[],
): Promise<number> {
  if (transiciones.length === 0) return 0

  const filas = transiciones.map(({ despliegue, estadoAnterior }) => ({
    despliegueUuid: despliegue.uuid,
    estado: despliegue.estado,
    estadoAnterior,
    observadoEn: new Date(),
    aplicacionUuid: despliegue.aplicacionUuid,
    aplicacionNombre: despliegue.aplicacionNombre,
    rama: despliegue.rama,
    commit: despliegue.commit,
    commitMensaje: despliegue.commitMensaje,
    iniciadoEn: despliegue.iniciadoEn === null ? null : new Date(despliegue.iniciadoEn),
    finalizadoEn: despliegue.finalizadoEn === null ? null : new Date(despliegue.finalizadoEn),
    duracionSegundos:
      despliegue.duracionSegundos === null ? null : Math.round(despliegue.duracionSegundos),
    url: despliegue.url,
  }))

  const insertadas = await db
    .insert(eventosDespliegue)
    .values(filas)
    .onConflictDoNothing()
    .returning({ id: eventosDespliegue.id })

  if (insertadas.length > 0) {
    await db.execute(sql`SELECT pg_notify(${CANAL_DESPLIEGUE}, '1')`)
  }

  return insertadas.length
}
