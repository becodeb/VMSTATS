import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type pg from 'pg'
import {
  PREFIJO_CLAVE,
  baseDesdeUrl,
  clavesApi,
  crearClave,
  esAlcance,
  generarClave,
  idDeClave,
  listarClaves,
  revocarClave,
  usuarios,
  validarClave,
  type BaseDatos,
} from '@vmstats/db'
import {
  alcancePermiteMetodo,
  secretoDeCabecera,
} from '../apps/web/src/lib/clavesApi.js'

/* ============================================================================
 * Claves de API.
 *
 * Dos mitades. La primera es pura —parsear la cabecera y decidir si un alcance
 * admite un método— y corre en cualquier lado. La segunda necesita PostgreSQL,
 * porque lo que hay que demostrar es que una clave revocada, vencida o de un
 * usuario deshabilitado NO valida, y eso vive en el WHERE de la consulta.
 * ========================================================================== */

describe('secretoDeCabecera', () => {
  const valido = `${PREFIJO_CLAVE}abcdef0123456789`

  it('acepta un Bearer con nuestro prefijo', () => {
    expect(secretoDeCabecera(`Bearer ${valido}`)).toBe(valido)
  })

  it('acepta el esquema en cualquier capitalización', () => {
    // RFC 7235: el esquema es case-insensitive. `bearer` en minúscula es lo
    // que mandan varios clientes HTTP.
    expect(secretoDeCabecera(`bearer ${valido}`)).toBe(valido)
    expect(secretoDeCabecera(`BEARER ${valido}`)).toBe(valido)
  })

  it('tolera espacios de más', () => {
    expect(secretoDeCabecera(`  Bearer   ${valido}  `)).toBe(valido)
  })

  it('rechaza otros esquemas', () => {
    expect(secretoDeCabecera(`Basic ${valido}`)).toBeNull()
    expect(secretoDeCabecera(`Token ${valido}`)).toBeNull()
  })

  it('rechaza un Bearer sin nuestro prefijo', () => {
    // Es lo que evita ir a la base por cada Authorization ajena que pase.
    expect(secretoDeCabecera('Bearer ghp_algodeGitHub')).toBeNull()
    expect(secretoDeCabecera('Bearer eyJhbGciOiJIUzI1NiJ9.x.y')).toBeNull()
  })

  it('rechaza cabeceras mal formadas', () => {
    expect(secretoDeCabecera(null)).toBeNull()
    expect(secretoDeCabecera('')).toBeNull()
    expect(secretoDeCabecera('Bearer')).toBeNull()
    expect(secretoDeCabecera(valido)).toBeNull()
    expect(secretoDeCabecera(`Bearer ${valido} sobra`)).toBeNull()
  })
})

describe('alcancePermiteMetodo', () => {
  it('read sólo lee', () => {
    expect(alcancePermiteMetodo('read', 'GET')).toBe(true)
    expect(alcancePermiteMetodo('read', 'HEAD')).toBe(true)
    expect(alcancePermiteMetodo('read', 'POST')).toBe(false)
    expect(alcancePermiteMetodo('read', 'PATCH')).toBe(false)
    expect(alcancePermiteMetodo('read', 'DELETE')).toBe(false)
    expect(alcancePermiteMetodo('read', 'PUT')).toBe(false)
  })

  it('admin puede todo', () => {
    for (const metodo of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT']) {
      expect(alcancePermiteMetodo('admin', metodo)).toBe(true)
    }
  })
})

describe('esAlcance', () => {
  it('sólo reconoce los alcances conocidos', () => {
    expect(esAlcance('read')).toBe(true)
    expect(esAlcance('admin')).toBe(true)
    expect(esAlcance('root')).toBe(false)
    expect(esAlcance('')).toBe(false)
  })
})

describe('generarClave', () => {
  it('lleva el prefijo visible', () => {
    expect(generarClave().secreto.startsWith(PREFIJO_CLAVE)).toBe(true)
  })

  it('el id es el SHA-256 del secreto completo', () => {
    const { secreto, id } = generarClave()
    expect(id).toBe(createHash('sha256').update(secreto).digest('hex'))
    expect(id).toHaveLength(64)
  })

  it('el prefijo guardado no alcanza para reconstruir el secreto', () => {
    const { secreto, prefijo } = generarClave()
    expect(prefijo).toHaveLength(8)
    expect(secreto.length).toBeGreaterThan(prefijo.length + PREFIJO_CLAVE.length)
  })

  it('no repite', () => {
    const vistos = new Set<string>()
    for (let i = 0; i < 500; i += 1) vistos.add(generarClave().secreto)
    expect(vistos.size).toBe(500)
  })
})

/* -------------------------------------------------------------------------
 * Contra PostgreSQL
 * ---------------------------------------------------------------------- */

const URL_BASE = process.env['DATABASE_URL'] ?? ''
const hayBase = URL_BASE.length > 0

const EMAIL = 'claves-test@vmstats.local'

let pool: pg.Pool
let db: BaseDatos
let usuarioId: string

describe.skipIf(!hayBase)('claves contra PostgreSQL', () => {
  beforeAll(async () => {
    const conexion = baseDesdeUrl({ url: URL_BASE, maxConexiones: 4 })
    pool = conexion.pool
    db = conexion.db
    await limpiar()

    const creados = await db
      .insert(usuarios)
      .values({
        email: EMAIL,
        nombre: 'Prueba',
        // No es un hash válido de Argon2; nada en estos tests lo verifica.
        hashContrasenia: 'x',
        rol: 'admin',
      })
      .returning({ id: usuarios.id })

    const id = creados[0]?.id
    if (id === undefined) throw new Error('no se pudo crear el usuario de prueba')
    usuarioId = id
  })

  afterAll(async () => {
    if (pool !== undefined) {
      await limpiar()
      await pool.end()
    }
  })

  async function limpiar(): Promise<void> {
    // El borrado de la clave va en cascada por la FK.
    await db.delete(usuarios).where(sql`lower(${usuarios.email}) = ${EMAIL}`)
  }

  it('una clave recién creada valida y trae al usuario', async () => {
    const { secreto } = await crearClave(db, {
      usuarioId,
      nombre: 'viva',
      alcance: 'read',
      diasValidez: 30,
    })

    const activa = await validarClave(db, secreto)
    expect(activa).not.toBeNull()
    expect(activa?.email).toBe(EMAIL)
    expect(activa?.alcance).toBe('read')
  })

  it('el secreto no queda en la base', async () => {
    const { secreto } = await crearClave(db, {
      usuarioId,
      nombre: 'no-en-claro',
      alcance: 'read',
      diasValidez: null,
    })

    // La única fila que existe es la del hash. Buscar el secreto entero por
    // cualquier columna de texto no tiene que devolver nada.
    const filas = await db
      .select({ id: clavesApi.id, nombre: clavesApi.nombre, prefijo: clavesApi.prefijo })
      .from(clavesApi)
      .where(eq(clavesApi.id, idDeClave(secreto)))

    expect(filas).toHaveLength(1)
    expect(filas[0]?.id).not.toBe(secreto)
    expect(JSON.stringify(filas[0])).not.toContain(secreto)
  })

  it('un secreto inventado no valida', async () => {
    expect(await validarClave(db, `${PREFIJO_CLAVE}noExisteEnAbsoluto`)).toBeNull()
  })

  it('una clave revocada deja de validar', async () => {
    const { secreto, clave } = await crearClave(db, {
      usuarioId,
      nombre: 'a-revocar',
      alcance: 'admin',
      diasValidez: null,
    })
    expect(await validarClave(db, secreto)).not.toBeNull()

    expect(await revocarClave(db, usuarioId, clave.id)).toBe(true)
    expect(await validarClave(db, secreto)).toBeNull()
  })

  it('no se puede revocar la clave de otro usuario', async () => {
    const { clave } = await crearClave(db, {
      usuarioId,
      nombre: 'ajena',
      alcance: 'read',
      diasValidez: null,
    })

    // Conocer el id no alcanza: el UPDATE filtra también por usuario.
    const otro = '00000000-0000-4000-8000-000000000000'
    expect(await revocarClave(db, otro, clave.id)).toBe(false)
  })

  it('revocar dos veces devuelve false la segunda', async () => {
    const { clave } = await crearClave(db, {
      usuarioId,
      nombre: 'doble-revocacion',
      alcance: 'read',
      diasValidez: null,
    })
    expect(await revocarClave(db, usuarioId, clave.id)).toBe(true)
    expect(await revocarClave(db, usuarioId, clave.id)).toBe(false)
  })

  it('una clave vencida no valida', async () => {
    const { secreto, clave } = await crearClave(db, {
      usuarioId,
      nombre: 'vencida',
      alcance: 'read',
      diasValidez: 1,
    })
    expect(await validarClave(db, secreto)).not.toBeNull()

    // Se corre el vencimiento al pasado en vez de esperar un día.
    await db
      .update(clavesApi)
      .set({ expiraEn: new Date(Date.now() - 1000) })
      .where(eq(clavesApi.id, clave.id))

    expect(await validarClave(db, secreto)).toBeNull()
  })

  it('sin vencimiento, sigue validando', async () => {
    const { secreto } = await crearClave(db, {
      usuarioId,
      nombre: 'eterna',
      alcance: 'read',
      diasValidez: null,
    })
    expect(await validarClave(db, secreto)).not.toBeNull()
  })

  it('la clave de un usuario deshabilitado no valida', async () => {
    const { secreto } = await crearClave(db, {
      usuarioId,
      nombre: 'de-usuario-baja',
      alcance: 'admin',
      diasValidez: null,
    })
    expect(await validarClave(db, secreto)).not.toBeNull()

    await db
      .update(usuarios)
      .set({ deshabilitadoEn: new Date() })
      .where(eq(usuarios.id, usuarioId))

    // Dar de baja a alguien tiene que cortarle también el acceso programático;
    // si no, revocar una persona dejaría sus scripts andando.
    expect(await validarClave(db, secreto)).toBeNull()

    await db
      .update(usuarios)
      .set({ deshabilitadoEn: null })
      .where(eq(usuarios.id, usuarioId))
  })

  it('un alcance desconocido en la base falla cerrado', async () => {
    const { secreto, clave } = await crearClave(db, {
      usuarioId,
      nombre: 'alcance-raro',
      alcance: 'read',
      diasValidez: null,
    })

    // Simula una base escrita por una versión más nueva. Preferimos rechazar
    // antes que asumir el alcance más bajo y dejar pasar algo mal entendido.
    await db
      .update(clavesApi)
      .set({ alcance: 'superusuario' })
      .where(eq(clavesApi.id, clave.id))

    expect(await validarClave(db, secreto)).toBeNull()
  })

  it('listar no muestra las revocadas ni expone el secreto', async () => {
    const { clave } = await crearClave(db, {
      usuarioId,
      nombre: 'listada',
      alcance: 'read',
      diasValidez: 7,
    })

    const antes = await listarClaves(db, usuarioId)
    expect(antes.some((c) => c.id === clave.id)).toBe(true)
    // El prefijo sí; el secreto no está ni podría estarlo.
    expect(antes.every((c) => c.prefijo.length === 8)).toBe(true)

    await revocarClave(db, usuarioId, clave.id)
    const despues = await listarClaves(db, usuarioId)
    expect(despues.some((c) => c.id === clave.id)).toBe(false)
  })

  it('validar marca el último uso', async () => {
    const { secreto, clave } = await crearClave(db, {
      usuarioId,
      nombre: 'marca-uso',
      alcance: 'read',
      diasValidez: null,
    })

    const antes = await db
      .select({ usadaEn: clavesApi.usadaEn })
      .from(clavesApi)
      .where(eq(clavesApi.id, clave.id))
    expect(antes[0]?.usadaEn).toBeNull()

    await validarClave(db, secreto)

    const despues = await db
      .select({ usadaEn: clavesApi.usadaEn })
      .from(clavesApi)
      .where(eq(clavesApi.id, clave.id))
    expect(despues[0]?.usadaEn).not.toBeNull()
  })
})
