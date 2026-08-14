import type { Despliegue, EstadoDespliegue } from '@vmstats/shared'
import { esDespliegueActivo } from '@vmstats/shared'

/* ============================================================================
 * Seguimiento de despliegues.
 *
 * Dos problemas que resuelve este archivo:
 *
 * 1. `/deployments` sólo devuelve los que están corriendo. Un despliegue que
 *    termina simplemente desaparece de la lista, así que hay que ir a buscar su
 *    estado final por uuid — si no, en la base quedan despliegues eternamente
 *    «en curso».
 *
 * 2. El polling ve el mismo estado una y otra vez. Guardar cada respuesta
 *    llenaría la tabla de duplicados; sólo se registran las transiciones.
 *
 * La lógica es pura y el estado entra por parámetro para poder testear
 * secuencias completas de polling sin red ni base.
 * ========================================================================== */

export interface Transicion {
  despliegue: Despliegue
  estadoAnterior: EstadoDespliegue | null
}

export interface ResultadoDiferencia {
  /** Cambios de estado a persistir. */
  transiciones: Transicion[]
  /** Uuids que desaparecieron de la lista y hay que ir a buscar por separado. */
  aConsultar: string[]
  /** El mapa de estados conocidos, ya actualizado. */
  conocidos: Map<string, EstadoDespliegue>
}

/**
 * Compara la respuesta del polling contra lo que ya sabíamos.
 *
 * `conocidos` no se muta: se devuelve una copia nueva. El llamador la adopta
 * recién cuando la persistencia salió bien, así un fallo de base no hace que
 * el collector "olvide" una transición que nunca llegó a guardar.
 */
export function diferenciarDespliegues(
  activos: readonly Despliegue[],
  conocidosPrevios: ReadonlyMap<string, EstadoDespliegue>,
): ResultadoDiferencia {
  const conocidos = new Map(conocidosPrevios)
  const transiciones: Transicion[] = []
  const vistos = new Set<string>()

  for (const despliegue of activos) {
    vistos.add(despliegue.uuid)
    const anterior = conocidosPrevios.get(despliegue.uuid) ?? null

    if (anterior !== despliegue.estado) {
      transiciones.push({ despliegue, estadoAnterior: anterior })
      conocidos.set(despliegue.uuid, despliegue.estado)
    }
  }

  // Los que estaban activos y ya no aparecen: terminaron, fallaron o los
  // cancelaron. Hay que preguntarle a Coolify cuál de las tres.
  const aConsultar: string[] = []
  for (const [uuid, estado] of conocidosPrevios) {
    if (vistos.has(uuid)) continue
    if (esDespliegueActivo(estado)) aConsultar.push(uuid)
    else conocidos.delete(uuid)
  }

  return { transiciones, aConsultar, conocidos }
}

/**
 * Resuelve un despliegue que desapareció de la lista de activos.
 *
 * Si Coolify ya no lo conoce (`null`), lo damos por terminado con estado
 * desconocido en vez de dejarlo colgado: un despliegue «en curso» de hace tres
 * días en la UI es peor que uno honestamente marcado como desconocido.
 */
export function resolverDesaparecido(
  uuid: string,
  encontrado: Despliegue | null,
  estadoAnterior: EstadoDespliegue,
): Transicion {
  if (encontrado !== null) {
    return { despliegue: encontrado, estadoAnterior }
  }

  return {
    estadoAnterior,
    despliegue: {
      uuid,
      aplicacionUuid: null,
      aplicacionNombre: null,
      estado: 'unknown',
      rama: null,
      commit: null,
      commitMensaje: null,
      iniciadoEn: null,
      finalizadoEn: new Date().toISOString(),
      duracionSegundos: null,
      url: null,
    },
  }
}

/* -------------------------------------------------------------------------
 * Ritmo del polling
 * ---------------------------------------------------------------------- */

export interface OpcionesRitmo {
  /** Con un despliegue en curso, queremos verlo casi en vivo. */
  intervaloActivoMs: number
  /** Sin despliegues, la API no tiene nada nuevo que contar. */
  intervaloOciosoMs: number
  /** Techo del backoff exponencial ante errores. */
  intervaloMaximoMs: number
}

export const RITMO_POR_DEFECTO: OpcionesRitmo = {
  intervaloActivoMs: 5_000,
  intervaloOciosoMs: 30_000,
  intervaloMaximoMs: 300_000,
}

/**
 * Decide cuánto esperar hasta el próximo poll.
 *
 * Con errores consecutivos el intervalo se duplica desde el valor ocioso hasta
 * el techo. Si la instancia de Coolify está caída, el collector no la castiga
 * con un pedido cada cinco segundos durante horas.
 */
export function proximoIntervalo(
  hayActivos: boolean,
  erroresConsecutivos: number,
  opciones: OpcionesRitmo = RITMO_POR_DEFECTO,
): number {
  if (erroresConsecutivos > 0) {
    const escalado = opciones.intervaloOciosoMs * 2 ** (erroresConsecutivos - 1)
    return Math.min(escalado, opciones.intervaloMaximoMs)
  }
  return hayActivos ? opciones.intervaloActivoMs : opciones.intervaloOciosoMs
}
