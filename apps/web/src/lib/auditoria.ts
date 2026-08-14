import { auditoria, type BaseDatos } from '@vmstats/db'

/* ============================================================================
 * Registro de auditoría.
 *
 * Qué se audita: entrar, salir, tocar reglas de alerta, silenciar, reconocer y
 * cambiar preferencias. Lo que la spec pide, más los cambios de configuración.
 *
 * Qué NO se audita: la navegación. Un registro que anota cada vista abierta se
 * vuelve ruido y esconde justo los eventos que importan.
 * ========================================================================== */

export type AccionAuditada =
  | 'login.exito'
  | 'login.fallo'
  | 'login.bloqueado'
  | 'logout'
  | 'alerta.regla.crear'
  | 'alerta.regla.editar'
  | 'alerta.regla.borrar'
  | 'alerta.silenciar'
  | 'alerta.reconocer'
  | 'preferencias.editar'
  | 'admin.crear'
  | 'clave.crear'
  | 'clave.revocar'

export interface EntradaAuditoria {
  accion: AccionAuditada
  usuarioId?: string | null
  usuarioEmail?: string | null
  objetivo?: string | null
  detalle?: Record<string, unknown> | null
  ip?: string | null
}

/**
 * Escribe una entrada.
 *
 * Nunca lanza: un fallo al auditar no puede impedir la operación que se estaba
 * auditando. Si la tabla no está disponible, queda en el log del servidor.
 */
export async function auditar(db: BaseDatos, entrada: EntradaAuditoria): Promise<void> {
  try {
    await db.insert(auditoria).values({
      accion: entrada.accion,
      usuarioId: entrada.usuarioId ?? null,
      usuarioEmail: entrada.usuarioEmail ?? null,
      objetivo: entrada.objetivo ?? null,
      detalle: entrada.detalle ?? null,
      ip: entrada.ip ?? null,
    })
  } catch (error) {
    console.error('[auditoría] no se pudo registrar', entrada.accion, error)
  }
}
