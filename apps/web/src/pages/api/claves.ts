import type { APIRoute } from 'astro'
import { z } from 'zod'
import { base } from '../../lib/base.js'
import { auditar } from '../../lib/auditoria.js'
import { ALCANCES, crearClave, listarClaves, revocarClave } from '../../lib/clavesApi.js'
import { error, json, protegido } from '../../lib/respuestas.js'

export const prerender = false

/* ============================================================================
 * Claves de API: listar, crear y revocar.
 *
 * Regla que gobierna todo este archivo: administrar claves exige una sesión de
 * navegador. Una clave de API no puede crear otra clave de API.
 *
 * Sin eso, `admin` sería en la práctica permanente e irrevocable: quien se
 * hiciera con una clave podría emitirse otras sin límite, y revocar la original
 * no serviría de nada. Es la escalada de privilegios clásica de todo sistema de
 * tokens, y se corta acá, en el único lugar donde se emiten.
 * ========================================================================== */

const esquemaCreacion = z.object({
  nombre: z.string().trim().min(1, 'Poné un nombre.').max(80),
  alcance: z.enum(ALCANCES),
  /* Vencimiento en días. `null` es explícito —«no vence»— y no el valor por
   * defecto: obligar a elegir hace que nadie termine con una clave eterna sin
   * haberlo decidido. */
  diasValidez: z.number().int().positive().max(3650).nullable(),
})

const esquemaRevocacion = z.object({
  id: z.string().length(64, 'Identificador inválido.'),
})

export const GET: APIRoute = async ({ locals }) =>
  protegido(async () => {
    const quien = locals.identidad
    if (quien === null) return error('no_autenticado')

    return json({ claves: await listarClaves(base(), quien.usuarioId) })
  }, 'GET /api/claves')

export const POST: APIRoute = async ({ request, locals }) =>
  protegido(async () => {
    const sesion = locals.sesion
    if (sesion === null) {
      return error(
        'sin_permiso',
        'Las claves de API sólo se pueden crear desde la consola, con tu sesión iniciada.',
      )
    }

    let cuerpo: unknown
    try {
      cuerpo = await request.json()
    } catch {
      return error('entrada_invalida')
    }

    const validado = esquemaCreacion.safeParse(cuerpo)
    if (!validado.success) {
      return error('entrada_invalida', validado.error.issues[0]?.message)
    }

    const db = base()
    const { secreto, clave } = await crearClave(db, {
      usuarioId: sesion.usuarioId,
      ...validado.data,
    })

    await auditar(db, {
      accion: 'clave.crear',
      usuarioId: sesion.usuarioId,
      usuarioEmail: sesion.email,
      objetivo: clave.id,
      // El nombre y el alcance sí; el secreto jamás, ni siquiera acá.
      detalle: { nombre: clave.nombre, alcance: clave.alcance, expiraEn: clave.expiraEn },
    })

    /* El secreto viaja una única vez, en esta respuesta. No se guarda en claro
     * en ningún lado, así que no hay forma de volver a mostrarlo: si se pierde,
     * se revoca y se crea otra. */
    return json({ secreto, clave }, 201)
  }, 'POST /api/claves')

export const DELETE: APIRoute = async ({ request, locals }) =>
  protegido(async () => {
    const sesion = locals.sesion
    if (sesion === null) {
      return error(
        'sin_permiso',
        'Las claves de API sólo se pueden revocar desde la consola, con tu sesión iniciada.',
      )
    }

    let cuerpo: unknown
    try {
      cuerpo = await request.json()
    } catch {
      return error('entrada_invalida')
    }

    const validado = esquemaRevocacion.safeParse(cuerpo)
    if (!validado.success) {
      return error('entrada_invalida', validado.error.issues[0]?.message)
    }

    const db = base()
    const revocada = await revocarClave(db, sesion.usuarioId, validado.data.id)
    if (!revocada) return error('no_encontrado')

    await auditar(db, {
      accion: 'clave.revocar',
      usuarioId: sesion.usuarioId,
      usuarioEmail: sesion.email,
      objetivo: validado.data.id,
    })

    return json({ revocada: true })
  }, 'DELETE /api/claves')
