import type { APIRoute } from 'astro'
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  esquemaEntradaReglaAlerta,
  esquemaMetricaAlerta,
  esquemaSeveridad,
  type InstanciaAlerta,
} from '@vmstats/shared'
import { alertasAbiertas, instanciasAlerta, reglasAlerta } from '@vmstats/db'
import { base } from '@/lib/base'
import { auditar } from '@/lib/auditoria'
import { error, json, protegido } from '@/lib/respuestas'

/* ============================================================================
 * Alertas: reglas e instancias.
 *
 * Las mutaciones se auditan todas. La spec lo pide para cambios de reglas y
 * silenciamientos; se agregan los reconocimientos por el mismo criterio —
 * saber quién dio por vista una alerta crítica importa tanto como saber quién
 * la silenció.
 *
 * No hay notificaciones externas. Ni acá ni en ningún lado del código: la spec
 * lo prohíbe por defecto y no existe el camino.
 * ========================================================================== */

/** Alertas resueltas de los últimos 7 días, para la pestaña de historial. */
const DIAS_RESUELTAS = 7

export const GET: APIRoute = async () =>
  protegido(async () => {
    const db = base()

    const [abiertas, resueltas, reglas] = await Promise.all([
      alertasAbiertas(db),
      db
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
        .where(
          and(
            isNotNull(instanciasAlerta.resueltaEn),
            gte(
              instanciasAlerta.resueltaEn,
              new Date(Date.now() - DIAS_RESUELTAS * 86_400_000),
            ),
          ),
        )
        .orderBy(desc(instanciasAlerta.resueltaEn))
        .limit(100),
      db.select().from(reglasAlerta).orderBy(reglasAlerta.severidad, reglasAlerta.nombre),
    ])

    const resueltasValidadas: InstanciaAlerta[] = resueltas.flatMap((fila) => {
      const metrica = esquemaMetricaAlerta.safeParse(fila.metrica)
      const severidad = esquemaSeveridad.safeParse(fila.severidad)
      if (!metrica.success || !severidad.success) return []
      return [
        {
          id: fila.id,
          reglaId: fila.reglaId,
          reglaNombre: fila.reglaNombre,
          metrica: metrica.data,
          severidad: severidad.data,
          estado: 'resuelta' as const,
          valorDisparo: fila.valorDisparo,
          umbral: fila.umbral,
          iniciadaEn: fila.iniciadaEn.toISOString(),
          resueltaEn: fila.resueltaEn?.toISOString() ?? null,
          reconocidaEn: fila.reconocidaEn?.toISOString() ?? null,
          reconocidaPor: null,
        },
      ]
    })

    return json({
      abiertas,
      resueltas: resueltasValidadas,
      reglas: reglas.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        metrica: r.metrica,
        operador: r.operador,
        umbral: r.umbral,
        severidad: r.severidad,
        duracionMinimaSegundos: r.duracionMinimaSegundos,
        cooldownSegundos: r.cooldownSegundos,
        histeresis: r.histeresis,
        habilitada: r.habilitada,
        silenciadaHasta: r.silenciadaHasta?.toISOString() ?? null,
      })),
    })
  }, 'GET /api/alertas')

/* -------------------------------------------------------------------------
 * Acciones
 * ---------------------------------------------------------------------- */

const esquemaAccion = z.discriminatedUnion('accion', [
  z.object({ accion: z.literal('reconocer'), instanciaId: z.number().int() }),
  z.object({
    accion: z.literal('silenciar'),
    reglaId: z.number().int(),
    /** 0 levanta el silencio. */
    minutos: z.number().int().min(0).max(10_080),
  }),
  z.object({
    accion: z.literal('crear-regla'),
    regla: esquemaEntradaReglaAlerta,
  }),
  z.object({
    accion: z.literal('editar-regla'),
    reglaId: z.number().int(),
    regla: esquemaEntradaReglaAlerta.partial(),
  }),
  z.object({ accion: z.literal('borrar-regla'), reglaId: z.number().int() }),
])

export const POST: APIRoute = async ({ request, locals }) =>
  protegido(async () => {
    // `identidad` y no `sesion`: esto también se puede operar con una clave de
    // API de alcance `admin`, y el middleware ya verificó cuál de las dos es.
    const quienPide = locals.identidad
    if (quienPide === null) return error('no_autenticado')

    let cuerpo: unknown
    try {
      cuerpo = await request.json()
    } catch {
      return error('entrada_invalida')
    }

    const validado = esquemaAccion.safeParse(cuerpo)
    if (!validado.success) {
      return error('entrada_invalida', validado.error.issues[0]?.message)
    }

    const db = base()
    const orden = validado.data
    const quien = { usuarioId: quienPide.usuarioId, usuarioEmail: quienPide.email }

    if (orden.accion === 'reconocer') {
      const filas = await db
        .update(instanciasAlerta)
        .set({
          estado: 'reconocida',
          reconocidaEn: new Date(),
          reconocidaPor: quienPide.usuarioId,
        })
        .where(
          and(
            eq(instanciasAlerta.id, orden.instanciaId),
            eq(instanciasAlerta.estado, 'activa'),
          ),
        )
        .returning({ id: instanciasAlerta.id })

      if (filas.length === 0) return error('no_encontrado')

      await auditar(db, {
        ...quien,
        accion: 'alerta.reconocer',
        objetivo: String(orden.instanciaId),
      })
      return json({ ok: true })
    }

    if (orden.accion === 'silenciar') {
      // 0 minutos = levantar el silencio. Es más simple que un endpoint aparte
      // y deja el mismo rastro de auditoría.
      const hasta =
        orden.minutos === 0 ? null : new Date(Date.now() + orden.minutos * 60_000)

      const filas = await db
        .update(reglasAlerta)
        .set({ silenciadaHasta: hasta, actualizadaEn: new Date() })
        .where(eq(reglasAlerta.id, orden.reglaId))
        .returning({ id: reglasAlerta.id, nombre: reglasAlerta.nombre })

      if (filas.length === 0) return error('no_encontrado')

      await auditar(db, {
        ...quien,
        accion: 'alerta.silenciar',
        objetivo: filas[0]?.nombre ?? String(orden.reglaId),
        detalle: { hasta: hasta?.toISOString() ?? null, minutos: orden.minutos },
      })
      return json({ ok: true, silenciadaHasta: hasta?.toISOString() ?? null })
    }

    if (orden.accion === 'crear-regla') {
      const r = orden.regla
      const insertadas = await db
        .insert(reglasAlerta)
        .values({
          nombre: r.nombre,
          metrica: r.metrica,
          operador: r.operador,
          umbral: r.umbral,
          severidad: r.severidad,
          duracionMinimaSegundos: r.duracionMinimaSegundos,
          cooldownSegundos: r.cooldownSegundos,
          histeresis: r.histeresis,
          habilitada: r.habilitada,
          silenciadaHasta: r.silenciadaHasta === null ? null : new Date(r.silenciadaHasta),
        })
        .onConflictDoNothing()
        .returning({ id: reglasAlerta.id })

      if (insertadas.length === 0) {
        return error('entrada_invalida', 'Ya existe una regla con ese nombre.')
      }

      await auditar(db, { ...quien, accion: 'alerta.regla.crear', objetivo: r.nombre })
      return json({ ok: true, id: insertadas[0]?.id })
    }

    if (orden.accion === 'editar-regla') {
      const r = orden.regla
      const cambios = {
        ...(r.nombre === undefined ? {} : { nombre: r.nombre }),
        ...(r.metrica === undefined ? {} : { metrica: r.metrica }),
        ...(r.operador === undefined ? {} : { operador: r.operador }),
        ...(r.umbral === undefined ? {} : { umbral: r.umbral }),
        ...(r.severidad === undefined ? {} : { severidad: r.severidad }),
        ...(r.duracionMinimaSegundos === undefined
          ? {}
          : { duracionMinimaSegundos: r.duracionMinimaSegundos }),
        ...(r.cooldownSegundos === undefined ? {} : { cooldownSegundos: r.cooldownSegundos }),
        ...(r.histeresis === undefined ? {} : { histeresis: r.histeresis }),
        ...(r.habilitada === undefined ? {} : { habilitada: r.habilitada }),
        actualizadaEn: new Date(),
      }

      const filas = await db
        .update(reglasAlerta)
        .set(cambios)
        .where(eq(reglasAlerta.id, orden.reglaId))
        .returning({ id: reglasAlerta.id, nombre: reglasAlerta.nombre })

      if (filas.length === 0) return error('no_encontrado')

      await auditar(db, {
        ...quien,
        accion: 'alerta.regla.editar',
        objetivo: filas[0]?.nombre ?? String(orden.reglaId),
        detalle: cambios,
      })
      return json({ ok: true })
    }

    const filas = await db
      .delete(reglasAlerta)
      .where(eq(reglasAlerta.id, orden.reglaId))
      .returning({ nombre: reglasAlerta.nombre })

    if (filas.length === 0) return error('no_encontrado')

    await auditar(db, {
      ...quien,
      accion: 'alerta.regla.borrar',
      objetivo: filas[0]?.nombre ?? String(orden.reglaId),
    })
    return json({ ok: true })
  }, 'POST /api/alertas')
