import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ============================================================================
 * Healthcheck del contenedor collector.
 *
 * Se ejecuta como comando (`node dist/salud.js`), no como endpoint HTTP: la
 * spec pide que el collector no exponga puertos, y un healthcheck por archivo
 * cumple lo mismo sin abrir nada.
 *
 * Sale con 0 si el collector escribió su marca de vida hace poco. Un proceso
 * vivo pero trabado — por ejemplo esperando para siempre a un Docker colgado —
 * deja de tocar el archivo y el healthcheck lo detecta; comprobar sólo que el
 * PID existe no lo detectaría.
 * ========================================================================== */

const ARCHIVO_VIDA = join(tmpdir(), 'vmstats-collector-vivo')

/** Tres ciclos de persistencia perdidos. */
const TOLERANCIA_MS = 45_000

async function principal(): Promise<void> {
  const contenido = await readFile(ARCHIVO_VIDA, 'utf8')
  const marca = Number.parseInt(contenido.trim(), 10)

  if (!Number.isFinite(marca)) {
    console.error('marca de vida ilegible')
    process.exit(1)
  }

  const antiguedad = Date.now() - marca
  if (antiguedad > TOLERANCIA_MS) {
    console.error(`última señal hace ${Math.round(antiguedad / 1000)} s`)
    process.exit(1)
  }

  process.exit(0)
}

principal().catch(() => {
  // Sin archivo: el collector todavía no completó su primer ciclo. Docker lo
  // trata como no saludable, que es correcto — todavía no lo está.
  console.error('sin marca de vida')
  process.exit(1)
})
