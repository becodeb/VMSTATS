import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { baseDesdeUrl } from './index.js'
import { sembrarConfiguracionInicial } from './semilla.js'

/**
 * Aplica las migraciones pendientes y siembra la configuración inicial.
 *
 * Corre en el arranque del contenedor web antes de levantar el servidor, y
 * también a mano con `npm run db:migrate`. Es idempotente: drizzle lleva su
 * propia tabla de migraciones aplicadas y la semilla usa `ON CONFLICT`.
 */
async function principal(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url.length === 0) {
    throw new Error('Falta DATABASE_URL')
  }

  const { pool, db } = baseDesdeUrl({ url, maxConexiones: 2 })
  const carpeta = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

  try {
    console.log('[migrate] aplicando migraciones desde', carpeta)
    await migrate(db, { migrationsFolder: carpeta })
    console.log('[migrate] migraciones al día')

    await sembrarConfiguracionInicial(db)
    console.log('[migrate] configuración inicial sembrada')
  } finally {
    await pool.end()
  }
}

principal().catch((error: unknown) => {
  console.error('[migrate] falló:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
