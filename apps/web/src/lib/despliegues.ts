import { desc, sql } from 'drizzle-orm'
import type { Despliegue, EstadoDespliegue, EventoDespliegue } from '@vmstats/shared'
import { esDespliegueActivo, esquemaEstadoDespliegue } from '@vmstats/shared'
import { eventosDespliegue, type BaseDatos } from '@vmstats/db'
import { aFecha, aIso, aNumeroOpcional } from './filas.js'

/* ============================================================================
 * Consultas de despliegues.
 *
 * La tabla guarda transiciones, no despliegues. El estado actual de un
 * despliegue es su transición más reciente, y eso es un `DISTINCT ON` — que en
 * PostgreSQL es la forma barata de hacer «la última fila por grupo», mucho más
 * que una subconsulta con `max(observed_at)`.
 *
 * Se modeló así porque el historial de cómo llegó un despliegue a fallar es
 * justamente lo que se quiere ver en la timeline; guardar sólo el estado final
 * lo perdería.
 * ========================================================================== */

/* Filas de SQL crudo: el driver decide los tipos, así que todo es `unknown`
 * y las conversiones pasan por `filas.ts`. */
type FilaDespliegue = Record<string, unknown>

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null
}

function filaADespliegue(fila: FilaDespliegue): Despliegue {
  const estado = esquemaEstadoDespliegue.safeParse(fila['status'])
  return {
    uuid: String(fila['deployment_uuid'] ?? ''),
    aplicacionUuid: texto(fila['application_uuid']),
    aplicacionNombre: texto(fila['application_name']),
    estado: estado.success ? estado.data : 'unknown',
    rama: texto(fila['branch']),
    commit: texto(fila['commit_sha']),
    commitMensaje: texto(fila['commit_message']),
    iniciadoEn: fila['started_at'] == null ? null : aIso(fila['started_at']),
    finalizadoEn: fila['finished_at'] == null ? null : aIso(fila['finished_at']),
    duracionSegundos: aNumeroOpcional(fila['duration_seconds']),
    url: texto(fila['url']),
  }
}

/**
 * El estado actual de cada despliegue: su última transición observada.
 *
 * `DISTINCT ON (deployment_uuid)` con `ORDER BY deployment_uuid, observed_at
 * DESC` se queda con la fila más reciente de cada uno.
 */
async function ultimasTransiciones(
  db: BaseDatos,
  limite: number,
): Promise<Despliegue[]> {
  const resultado = await db.execute<FilaDespliegue>(sql`
    SELECT DISTINCT ON (deployment_uuid)
      deployment_uuid, status, application_uuid, application_name,
      branch, commit_sha, commit_message,
      started_at, finished_at, duration_seconds, url
    FROM deployment_events
    ORDER BY deployment_uuid, observed_at DESC
    LIMIT ${limite}
  `)

  return resultado.rows.map(filaADespliegue)
}

/** Los que están en cola o corriendo ahora mismo. */
export async function desplieguesActivos(db: BaseDatos): Promise<Despliegue[]> {
  const todos = await ultimasTransiciones(db, 200)
  return todos
    .filter((d) => esDespliegueActivo(d.estado))
    .toSorted((a, b) => (b.iniciadoEn ?? '').localeCompare(a.iniciadoEn ?? ''))
}

export interface HistorialDespliegues {
  activos: Despliegue[]
  recientes: Despliegue[]
  eventos: EventoDespliegue[]
}

export async function historialDespliegues(
  db: BaseDatos,
  limite: number,
): Promise<HistorialDespliegues> {
  const resultado = await db.execute<FilaDespliegue>(sql`
    SELECT DISTINCT ON (deployment_uuid)
      deployment_uuid, status, application_uuid, application_name,
      branch, commit_sha, commit_message,
      started_at, finished_at, duration_seconds, url, observed_at
    FROM deployment_events
    ORDER BY deployment_uuid, observed_at DESC
  `)

  const porFecha = resultado.rows
    .toSorted((a, b) => aFecha(b['observed_at']).getTime() - aFecha(a['observed_at']).getTime())
    .map(filaADespliegue)

  const activos = porFecha.filter((d) => esDespliegueActivo(d.estado))
  const recientes = porFecha.filter((d) => !esDespliegueActivo(d.estado)).slice(0, limite)

  // La timeline muestra todas las transiciones, no sólo la última: es la
  // diferencia entre «falló» y «estuvo veinte minutos en cola y después falló».
  const filasEventos = await db
    .select()
    .from(eventosDespliegue)
    .orderBy(desc(eventosDespliegue.observadoEn))
    .limit(limite * 4)

  const eventos: EventoDespliegue[] = filasEventos.map((fila) => {
    const estado = esquemaEstadoDespliegue.safeParse(fila.estado)
    const anterior =
      fila.estadoAnterior === null
        ? null
        : esquemaEstadoDespliegue.safeParse(fila.estadoAnterior)

    return {
      id: fila.id,
      despliegueUuid: fila.despliegueUuid,
      estado: estado.success ? estado.data : 'unknown',
      estadoAnterior:
        anterior !== null && anterior.success ? (anterior.data as EstadoDespliegue) : null,
      observadoEn: fila.observadoEn.toISOString(),
      aplicacionNombre: fila.aplicacionNombre,
      rama: fila.rama,
      commit: fila.commit,
      commitMensaje: fila.commitMensaje,
    }
  })

  return { activos, recientes, eventos }
}

/** Transiciones dentro de un rango, para superponer en los gráficos. */
export async function eventosEnRango(
  db: BaseDatos,
  desde: Date,
  hasta: Date,
): Promise<EventoDespliegue[]> {
  const resultado = await db.execute<FilaDespliegue>(sql`
    SELECT id, deployment_uuid, status, previous_status, observed_at,
           application_name, branch, commit_sha, commit_message
    FROM deployment_events
    WHERE observed_at >= ${desde} AND observed_at <= ${hasta}
    ORDER BY observed_at
  `)

  return resultado.rows.map((fila) => {
    const estado = esquemaEstadoDespliegue.safeParse(fila['status'])
    const anteriorCrudo = fila['previous_status']
    const anterior =
      anteriorCrudo == null ? null : esquemaEstadoDespliegue.safeParse(anteriorCrudo)

    return {
      id: Number(fila['id'] ?? 0),
      despliegueUuid: String(fila['deployment_uuid'] ?? ''),
      estado: estado.success ? estado.data : 'unknown',
      estadoAnterior:
        anterior !== null && anterior.success ? (anterior.data as EstadoDespliegue) : null,
      observadoEn: aIso(fila['observed_at']) ?? new Date(0).toISOString(),
      aplicacionNombre: texto(fila['application_name']),
      rama: texto(fila['branch']),
      commit: texto(fila['commit_sha']),
      commitMensaje: texto(fila['commit_message']),
    }
  })
}
