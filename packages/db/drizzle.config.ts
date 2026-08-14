import { defineConfig } from 'drizzle-kit'

/* `drizzle-kit generate` no se conecta a la base: compara el esquema TypeScript
 * contra las migraciones ya escritas. El placeholder existe para poder generar
 * migraciones sin una base levantada; `migrate` sí exige la URL real. */
const url = process.env['DATABASE_URL'] ?? 'postgresql://vmstats@localhost:5432/vmstats'

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
