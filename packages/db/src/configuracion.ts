import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ZONA_HORARIA_POR_DEFECTO } from '@vmstats/shared'
import { configuracion } from './schema.js'
import type { BaseDatos } from './index.js'

/* ============================================================================
 * Preferencias de la instancia.
 *
 * Viven en `app_settings` como jsonb y se leen validadas: si alguien edita la
 * tabla a mano y deja un valor imposible, caemos al valor por defecto en vez de
 * romper el arranque.
 * ========================================================================== */

export const esquemaPreferenciasApp = z.object({
  /** Zona de visualización. Los datos siempre se guardan en UTC. */
  zonaHoraria: z.string().min(1).max(64).default(ZONA_HORARIA_POR_DEFECTO),
  retencionRawDias: z.number().int().min(1).max(90).default(7),
  retencionUnMinutoDias: z.number().int().min(1).max(400).default(30),
  retencionCincoMinutosDias: z.number().int().min(1).max(1200).default(365),
  /** Los logs de contenedor pueden requerir un token de Coolify con
   *  `read:sensitive`. Apagado por defecto, como pide la spec. */
  logsHabilitados: z.boolean().default(false),
  /** Cuántas líneas devuelve como máximo una consulta de logs. */
  logsMaxLineas: z.number().int().min(10).max(2000).default(200),
  logsMaxBytes: z.number().int().min(1024).max(2_000_000).default(256_000),
})

export type PreferenciasApp = z.infer<typeof esquemaPreferenciasApp>

export const PREFERENCIAS_POR_DEFECTO: PreferenciasApp = esquemaPreferenciasApp.parse({})

const CLAVE_PREFERENCIAS = 'preferencias'

export async function leerPreferencias(db: BaseDatos): Promise<PreferenciasApp> {
  const filas = await db
    .select()
    .from(configuracion)
    .where(eq(configuracion.clave, CLAVE_PREFERENCIAS))
    .limit(1)

  const fila = filas[0]
  if (fila === undefined) return PREFERENCIAS_POR_DEFECTO

  const resultado = esquemaPreferenciasApp.safeParse(fila.valor)
  return resultado.success ? resultado.data : PREFERENCIAS_POR_DEFECTO
}

/**
 * Cambios parciales.
 *
 * `| undefined` explícito en cada campo: con `exactOptionalPropertyTypes`, un
 * `Partial<T>` no admite que la propiedad esté presente con valor `undefined`,
 * que es exactamente lo que produce `esquema.partial().parse()`.
 */
export type CambiosPreferencias = {
  [K in keyof PreferenciasApp]?: PreferenciasApp[K] | undefined
}

export async function guardarPreferencias(
  db: BaseDatos,
  parciales: CambiosPreferencias,
): Promise<PreferenciasApp> {
  const actuales = await leerPreferencias(db)
  // Los `undefined` de `parciales` pisarían los valores actuales al hacer
  // spread, así que se filtran antes.
  const definidos = Object.fromEntries(
    Object.entries(parciales).filter(([, valor]) => valor !== undefined),
  )
  const nuevas = esquemaPreferenciasApp.parse({ ...actuales, ...definidos })

  await db
    .insert(configuracion)
    .values({ clave: CLAVE_PREFERENCIAS, valor: nuevas })
    .onConflictDoUpdate({
      target: configuracion.clave,
      set: { valor: nuevas, actualizadaEn: new Date() },
    })

  return nuevas
}
