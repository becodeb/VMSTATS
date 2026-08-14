import { z } from 'zod'

/* ============================================================================
 * Entorno del proceso web.
 *
 * Se valida una sola vez al arrancar. Si falta un secreto, el proceso no
 * levanta: es preferible que el contenedor no arranque a que arranque con una
 * sesión sin firmar o sin base.
 * ========================================================================== */

const esquema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),

  /* Clave de firma de los tokens CSRF. 32 bytes como mínimo.
   *
   * Cambiarla invalida los CSRF en vuelo (el usuario reintenta y listo), no
   * las sesiones: las sesiones viven en la base. */
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET tiene que tener al menos 32 caracteres'),

  /** En producción la cookie va con `Secure` y el CSP se endurece. */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Origen público, para validar `Origin` en las mutaciones. */
  PUBLIC_ORIGIN: z.string().default(''),

  /** Zona horaria inicial si la base todavía no tiene preferencias. */
  VMSTATS_ZONA_HORARIA: z.string().default('America/Miquelon'),

  /* Bootstrap del primer admin. De un solo uso: el script los consume y avisa
   * que hay que borrarlos. Nunca hay credenciales por defecto. */
  VMSTATS_ADMIN_EMAIL: z.string().default(''),
  VMSTATS_ADMIN_PASSWORD: z.string().default(''),
  VMSTATS_ADMIN_NOMBRE: z.string().default('Administrador'),
})

export type EntornoWeb = z.infer<typeof esquema>

let cacheado: EntornoWeb | null = null

export function entorno(): EntornoWeb {
  if (cacheado !== null) return cacheado

  const resultado = esquema.safeParse(process.env)
  if (!resultado.success) {
    const detalles = resultado.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Configuración inválida:\n${detalles}`)
  }

  cacheado = resultado.data
  return cacheado
}

export function esProduccion(): boolean {
  return entorno().NODE_ENV === 'production'
}
