import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { baseDesdeUrl } from './index.js'
import { usuarios } from './schema.js'
import { LARGO_MINIMO_CONTRASENIA, hashearContrasenia } from './contrasenias.js'

/* ============================================================================
 * Creación del primer administrador.
 *
 * vmstats no trae credenciales por defecto: una instalación recién desplegada
 * no tiene con qué entrar hasta que alguien corra esto. Es a propósito — una
 * consola con todas las métricas de la VM detrás de admin/admin es peor que no
 * tener consola.
 *
 * Vive en @vmstats/db, que se compila a JavaScript plano, justamente para que
 * el comando funcione dentro de la imagen de producción:
 *
 *     docker compose exec web node /app/packages/db/dist/bootstrap.js
 *
 * Dos modos:
 *   - Interactivo: pide los datos por consola.
 *   - Por entorno: VMSTATS_ADMIN_EMAIL y VMSTATS_ADMIN_PASSWORD, de un solo
 *     uso. El script avisa que hay que borrarlas después.
 * ========================================================================== */

const esquema = z.object({
  email: z.email('El email no es válido'),
  nombre: z.string().min(1).max(120),
  contrasenia: z
    .string()
    .min(
      LARGO_MINIMO_CONTRASENIA,
      `La contraseña tiene que tener al menos ${LARGO_MINIMO_CONTRASENIA} caracteres`,
    )
    .max(1024),
})

async function preguntar(): Promise<z.infer<typeof esquema>> {
  const porEntorno = {
    email: process.env['VMSTATS_ADMIN_EMAIL'] ?? '',
    contrasenia: process.env['VMSTATS_ADMIN_PASSWORD'] ?? '',
    nombre: process.env['VMSTATS_ADMIN_NOMBRE'] ?? 'Administrador',
  }

  if (porEntorno.email.length > 0 && porEntorno.contrasenia.length > 0) {
    console.log('Usando VMSTATS_ADMIN_EMAIL y VMSTATS_ADMIN_PASSWORD del entorno.')
    console.log('IMPORTANTE: borrá esas variables cuando termine. Son de un solo uso.')
    return esquema.parse(porEntorno)
  }

  const lector = createInterface({ input: stdin, output: stdout })
  try {
    const email = await lector.question('Email: ')
    const nombre = (await lector.question('Nombre [Administrador]: ')) || 'Administrador'
    // La contraseña se escribe visible: ocultarla en readline requiere trucos
    // que se rompen en distintas terminales, y esto se corre una sola vez en
    // una sesión que el operador controla.
    const contrasenia = await lector.question(
      `Contraseña (mínimo ${LARGO_MINIMO_CONTRASENIA} caracteres): `,
    )
    return esquema.parse({ email, nombre, contrasenia })
  } finally {
    lector.close()
  }
}

async function principal(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url.length === 0) {
    console.error('Falta DATABASE_URL.')
    process.exitCode = 1
    return
  }

  const { pool, db } = baseDesdeUrl({ url, maxConexiones: 2 })

  try {
    const existentes = await db.select({ n: sql<number>`count(*)::int` }).from(usuarios)
    const cuantos = existentes[0]?.n ?? 0

    if (cuantos > 0) {
      console.log(`Ya hay ${cuantos} usuario(s). Este script sólo crea el primero.`)
      return
    }

    const datos = await preguntar()
    const hash = await hashearContrasenia(datos.contrasenia)

    const creados = await db
      .insert(usuarios)
      .values({
        email: datos.email,
        nombre: datos.nombre,
        hashContrasenia: hash,
        rol: 'admin',
      })
      .returning({ id: usuarios.id, email: usuarios.email })

    const creado = creados[0]
    if (creado === undefined) {
      console.error('No se pudo crear el usuario.')
      process.exitCode = 1
      return
    }

    console.log(`Administrador creado: ${creado.email}`)
    console.log('Ya podés entrar en /login.')
  } catch (causa) {
    if (causa instanceof z.ZodError) {
      for (const problema of causa.issues) console.error(`- ${problema.message}`)
    } else {
      console.error('Falló:', causa instanceof Error ? causa.message : causa)
    }
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await principal()
