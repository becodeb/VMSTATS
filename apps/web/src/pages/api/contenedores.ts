import type { APIRoute } from 'astro'
import { sql } from 'drizzle-orm'
import { esquemaMuestraContenedor, type MuestraContenedor } from '@vmstats/shared'
import { base } from '@/lib/base'
import { json, protegido } from '@/lib/respuestas'
import { logsDisponibles } from '@/lib/collector'
import { aIso, aNumero, aNumeroOpcional } from '@/lib/filas'

/* ============================================================================
 * Última muestra de cada contenedor.
 *
 * En condiciones normales la UI recibe esto por SSE dentro de la instantánea.
 * Este endpoint existe para la carga inicial del servidor y para el fallback de
 * polling; devuelve exactamente la misma forma.
 * ========================================================================== */

/* Todo `unknown`: son filas de SQL crudo y el driver decide los tipos. Las
 * conversiones pasan por `lib/filas.ts`. */
type FilaContenedor = Record<string, unknown>

export const GET: APIRoute = async () =>
  protegido(async () => {
    const db = base()

    /* Una fila por contenedor, la más reciente. Se acota a la última hora para
     * no listar contenedores que ya no existen: si algo no reportó en una
     * hora, no está corriendo. */
    const resultado = await db.execute<FilaContenedor>(sql`
      SELECT DISTINCT ON (container_id) *
      FROM container_metric_samples
      WHERE resolution = 'raw' AND ts > now() - interval '1 hour'
      ORDER BY container_id, ts DESC
    `)

    const contenedores: MuestraContenedor[] = resultado.rows.flatMap((fila) => {
      const candidato = {
        hostId: fila['host_id'],
        contenedorId: fila['container_id'],
        ts: aIso(fila['ts']),
        nombre: fila['name'],
        imagen: fila['image'],
        estado: fila['state'],
        salud: fila['health'],
        cpuPorcentaje: aNumero(fila['cpu_percent']),
        memoriaBytes: aNumero(fila['memory_bytes']),
        memoriaLimiteBytes: aNumeroOpcional(fila['memory_limit_bytes']),
        redRxBytesPorSeg: aNumero(fila['net_rx_bps']),
        redTxBytesPorSeg: aNumero(fila['net_tx_bps']),
        bloqueLecturaBytesPorSeg: aNumero(fila['block_read_bps']),
        bloqueEscrituraBytesPorSeg: aNumero(fila['block_write_bps']),
        uptimeSegundos: aNumero(fila['uptime_seconds']),
        reinicios: aNumero(fila['restarts']),
        puertos: fila['ports'],
        coolifyAplicacion: fila['coolify_application'],
        coolifyUuid: fila['coolify_uuid'],
      }

      const validado = esquemaMuestraContenedor.safeParse(candidato)
      return validado.success ? [validado.data] : []
    })

    return json({ contenedores, logsDisponibles: logsDisponibles() })
  }, 'GET /api/contenedores')
