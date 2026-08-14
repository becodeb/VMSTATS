import { desc } from 'drizzle-orm'
import { conLock, evaluarSilencioCollector, latidosCollector } from '@vmstats/db'
import { base, pool } from './base.js'

/* ============================================================================
 * Vigilante del collector.
 *
 * Evalúa la única regla que el collector no puede evaluar: la de su propio
 * silencio. Cuando el collector se cae, deja de evaluar alertas — incluida la
 * que avisaría que se cayó. Este proceso es el que sigue en pie, así que le
 * toca a él.
 *
 * Es la contraparte del banner de «Datos desactualizados»: el banner avisa a
 * quien está mirando la pantalla; esto deja registro aunque no haya nadie.
 *
 * Corre en un intervalo del proceso web, protegido por advisory lock para que
 * dos réplicas no abran la misma alerta dos veces.
 * ========================================================================== */

const INTERVALO_MS = 30_000

let iniciado = false

async function comprobar(): Promise<void> {
  const db = base()

  const filas = await db
    .select({ vistoEn: latidosCollector.vistoEn })
    .from(latidosCollector)
    .orderBy(desc(latidosCollector.vistoEn))
    .limit(1)

  const ultimo = filas[0]?.vistoEn ?? null

  /* Sin ningún latido, el collector nunca reportó.
   *
   * Eso puede ser una instalación recién levantada, así que no se cuenta como
   * silencio: la alerta diría que "dejó de reportar" algo que todavía no
   * empezó. El estado vacío de la UI ya cubre ese caso. */
  if (ultimo === null) return

  const silencioSegundos = Math.max(0, (Date.now() - ultimo.getTime()) / 1000)

  await conLock(pool(), 'evaluacionAlertas', async () => {
    await evaluarSilencioCollector(db, silencioSegundos)
  })
}

/**
 * Arranca el vigilante una sola vez por proceso.
 *
 * Se llama desde el middleware, que corre en cada request: la guarda hace que
 * sólo la primera lo inicie. No se arranca al importar el módulo porque en el
 * build de Astro los módulos se evalúan también fuera del servidor.
 */
export function asegurarVigilante(): void {
  if (iniciado) return
  iniciado = true

  const tick = (): void => {
    void comprobar().catch((causa: unknown) => {
      console.error('[vigilante] falló la comprobación:', causa)
    })
  }

  // `unref` para que el intervalo no impida que el proceso termine cuando
  // Docker manda SIGTERM.
  const temporizador = setInterval(tick, INTERVALO_MS)
  temporizador.unref?.()

  tick()
}
