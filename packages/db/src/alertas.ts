import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import {
  ESTADO_EVALUACION_INICIAL,
  esquemaMetricaAlerta,
  esquemaOperador,
  esquemaSeveridad,
  evaluarRegla,
  valorDeMetrica,
  type ContextoMetricas,
  type EstadoEvaluacion,
  type InstanciaAlerta,
  type MetricaAlerta,
  type ReglaAlerta,
} from '@vmstats/shared'
import { CANAL_ALERTA, type BaseDatos } from './index.js'
import { estadoReglaAlerta, instanciasAlerta, reglasAlerta } from './schema.js'

/* ============================================================================
 * Motor de alertas.
 *
 * La lógica de cuándo abrir y cuándo cerrar vive en @vmstats/shared, pura y
 * testeada con relojes falsos. Este archivo se ocupa sólo de traer el estado de
 * la base, aplicarla y guardar el resultado.
 *
 * Vive en @vmstats/db y no en el collector porque hay una regla que el
 * collector no puede evaluar: la de su propio silencio. Ver
 * `METRICAS_DEL_COLLECTOR`.
 *
 * El estado se persiste porque si no, un reinicio del collector reinicia el
 * reloj de la duración mínima: una condición que llevaba nueve minutos de los
 * diez requeridos volvería a empezar de cero, y en un proceso que se reinicia
 * seguido la alerta no dispararía nunca.
 * ========================================================================== */

/** Convierte una fila de la base al tipo validado, o null si está corrupta. */
function filaARegla(fila: typeof reglasAlerta.$inferSelect): ReglaAlerta | null {
  const metrica = esquemaMetricaAlerta.safeParse(fila.metrica)
  const operador = esquemaOperador.safeParse(fila.operador)
  const severidad = esquemaSeveridad.safeParse(fila.severidad)

  // Una regla con una métrica que ya no existe (renombrada entre versiones) se
  // ignora en silencio en vez de tumbar todo el ciclo de evaluación.
  if (!metrica.success || !operador.success || !severidad.success) return null

  return {
    id: fila.id,
    nombre: fila.nombre,
    metrica: metrica.data,
    operador: operador.data,
    umbral: fila.umbral,
    severidad: severidad.data,
    duracionMinimaSegundos: fila.duracionMinimaSegundos,
    cooldownSegundos: fila.cooldownSegundos,
    histeresis: fila.histeresis,
    habilitada: fila.habilitada,
    silenciadaHasta: fila.silenciadaHasta?.toISOString() ?? null,
  }
}

async function cargarEstados(db: BaseDatos): Promise<Map<number, EstadoEvaluacion>> {
  const filas = await db.select().from(estadoReglaAlerta)
  const mapa = new Map<number, EstadoEvaluacion>()

  for (const fila of filas) {
    mapa.set(fila.reglaId, {
      condicionDesde: fila.condicionDesde?.getTime() ?? null,
      activaDesde: fila.activaDesde?.getTime() ?? null,
      ultimaResolucion: fila.ultimaResolucion?.getTime() ?? null,
    })
  }

  return mapa
}

async function guardarEstado(
  db: BaseDatos,
  reglaId: number,
  estado: EstadoEvaluacion,
): Promise<void> {
  const valores = {
    reglaId,
    condicionDesde: estado.condicionDesde === null ? null : new Date(estado.condicionDesde),
    activaDesde: estado.activaDesde === null ? null : new Date(estado.activaDesde),
    ultimaResolucion:
      estado.ultimaResolucion === null ? null : new Date(estado.ultimaResolucion),
  }

  await db
    .insert(estadoReglaAlerta)
    .values(valores)
    .onConflictDoUpdate({ target: estadoReglaAlerta.reglaId, set: valores })
}

interface Delta {
  nuevas: number
  resueltas: number
}

/**
 * Aplica la máquina de estados a una regla y persiste lo que corresponda.
 *
 * El índice parcial `alert_instances_una_abierta_idx` garantiza que no haya dos
 * instancias abiertas por regla aunque dos evaluaciones se solapen — el
 * `ON CONFLICT DO NOTHING` la descarta sin ruido.
 */
async function aplicarRegla(
  db: BaseDatos,
  regla: ReglaAlerta,
  valor: number,
  ahora: number,
  previo: EstadoEvaluacion,
): Promise<Delta> {
  const { estado, accion } = evaluarRegla(regla, valor, ahora, previo)
  let nuevas = 0
  let resueltas = 0

  if (accion.tipo === 'abrir') {
    const insertadas = await db
      .insert(instanciasAlerta)
      .values({
        reglaId: regla.id,
        estado: 'activa',
        valorDisparo: accion.valor,
        umbral: regla.umbral,
        severidad: regla.severidad,
        iniciadaEn: new Date(ahora),
      })
      .onConflictDoNothing()
      .returning({ id: instanciasAlerta.id })
    nuevas = insertadas.length
  } else if (accion.tipo === 'resolver') {
    const cerradas = await db
      .update(instanciasAlerta)
      .set({ estado: 'resuelta', resueltaEn: new Date(ahora) })
      .where(
        and(eq(instanciasAlerta.reglaId, regla.id), ne(instanciasAlerta.estado, 'resuelta')),
      )
      .returning({ id: instanciasAlerta.id })
    resueltas = cerradas.length
  }

  await guardarEstado(db, regla.id, estado)
  return { nuevas, resueltas }
}

export interface ResultadoEvaluacionCiclo {
  abiertas: InstanciaAlerta[]
  nuevas: number
  resueltas: number
  /** Métricas que ninguna regla pudo evaluar por falta de datos. */
  sinDatos: MetricaAlerta[]
}

/**
 * Métricas que el collector NO evalúa.
 *
 * `collector.silencioSegundos` mide cuánto hace que el collector no reporta, y
 * el collector siempre está vivo en el momento de evaluarla: la regla nunca
 * dispararía. La evalúa el proceso web, que es el que sigue en pie cuando el
 * collector se cae. Ver `evaluarSilencioCollector`.
 */
export const METRICAS_DEL_COLLECTOR: readonly MetricaAlerta[] = ['collector.silencioSegundos']

/**
 * Evalúa las reglas contra la muestra actual.
 *
 * Devuelve las alertas abiertas para que el collector las incluya en la
 * instantánea que empuja por SSE: así el navegador ve la alerta en el mismo
 * ciclo en que se abrió, sin tener que preguntar por separado.
 */
export async function evaluarCiclo(
  db: BaseDatos,
  contexto: ContextoMetricas,
  ahora: number = Date.now(),
  excluidas: readonly MetricaAlerta[] = METRICAS_DEL_COLLECTOR,
): Promise<ResultadoEvaluacionCiclo> {
  const filas = await db.select().from(reglasAlerta)
  const estados = await cargarEstados(db)

  let nuevas = 0
  let resueltas = 0
  const sinDatos: MetricaAlerta[] = []

  for (const fila of filas) {
    const regla = filaARegla(fila)
    if (regla === null) continue
    if (excluidas.includes(regla.metrica)) continue

    const valor = valorDeMetrica(regla.metrica, contexto)
    if (valor === null) {
      sinDatos.push(regla.metrica)
      continue
    }

    const delta = await aplicarRegla(
      db,
      regla,
      valor,
      ahora,
      estados.get(regla.id) ?? ESTADO_EVALUACION_INICIAL,
    )
    nuevas += delta.nuevas
    resueltas += delta.resueltas
  }

  if (nuevas > 0 || resueltas > 0) {
    await db.execute(sql`SELECT pg_notify(${CANAL_ALERTA}, '1')`)
  }

  return { abiertas: await alertasAbiertas(db), nuevas, resueltas, sinDatos }
}

/**
 * Evalúa únicamente las reglas sobre el silencio del collector.
 *
 * La corre el proceso web en un intervalo propio. Es la contraparte del banner
 * de «Datos desactualizados»: el banner avisa a quien está mirando la pantalla,
 * la alerta queda registrada aunque no haya nadie mirando.
 */
export async function evaluarSilencioCollector(
  db: BaseDatos,
  silencioSegundos: number,
  ahora: number = Date.now(),
): Promise<Delta> {
  const filas = await db.select().from(reglasAlerta)
  const estados = await cargarEstados(db)

  let nuevas = 0
  let resueltas = 0

  for (const fila of filas) {
    const regla = filaARegla(fila)
    if (regla === null || !METRICAS_DEL_COLLECTOR.includes(regla.metrica)) continue

    const delta = await aplicarRegla(
      db,
      regla,
      silencioSegundos,
      ahora,
      estados.get(regla.id) ?? ESTADO_EVALUACION_INICIAL,
    )
    nuevas += delta.nuevas
    resueltas += delta.resueltas
  }

  if (nuevas > 0 || resueltas > 0) {
    await db.execute(sql`SELECT pg_notify(${CANAL_ALERTA}, '1')`)
  }

  return { nuevas, resueltas }
}

/** Alertas activas o reconocidas, con los datos de su regla. */
export async function alertasAbiertas(db: BaseDatos): Promise<InstanciaAlerta[]> {
  const filas = await db
    .select({
      id: instanciasAlerta.id,
      reglaId: instanciasAlerta.reglaId,
      reglaNombre: reglasAlerta.nombre,
      metrica: reglasAlerta.metrica,
      severidad: instanciasAlerta.severidad,
      estado: instanciasAlerta.estado,
      valorDisparo: instanciasAlerta.valorDisparo,
      umbral: instanciasAlerta.umbral,
      iniciadaEn: instanciasAlerta.iniciadaEn,
      resueltaEn: instanciasAlerta.resueltaEn,
      reconocidaEn: instanciasAlerta.reconocidaEn,
    })
    .from(instanciasAlerta)
    .innerJoin(reglasAlerta, eq(instanciasAlerta.reglaId, reglasAlerta.id))
    .where(isNull(instanciasAlerta.resueltaEn))
    .orderBy(instanciasAlerta.iniciadaEn)

  return filas.flatMap((fila): InstanciaAlerta[] => {
    const metrica = esquemaMetricaAlerta.safeParse(fila.metrica)
    const severidad = esquemaSeveridad.safeParse(fila.severidad)
    if (!metrica.success || !severidad.success) return []

    const estado =
      fila.estado === 'reconocida'
        ? 'reconocida'
        : fila.estado === 'resuelta'
          ? 'resuelta'
          : 'activa'

    return [
      {
        id: fila.id,
        reglaId: fila.reglaId,
        reglaNombre: fila.reglaNombre,
        metrica: metrica.data,
        severidad: severidad.data,
        estado,
        valorDisparo: fila.valorDisparo,
        umbral: fila.umbral,
        iniciadaEn: fila.iniciadaEn.toISOString(),
        resueltaEn: fila.resueltaEn?.toISOString() ?? null,
        reconocidaEn: fila.reconocidaEn?.toISOString() ?? null,
        reconocidaPor: null,
      },
    ]
  })
}
