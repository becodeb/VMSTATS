import { chromium, devices } from 'playwright'
import { mkdirSync } from 'node:fs'

/* ============================================================================
 * Capturas de la consola, en claro y oscuro, escritorio y móvil.
 *
 * Herramienta de desarrollo: sirve para revisar los dos temas de un vistazo sin
 * ir pantalla por pantalla. No forma parte del despliegue.
 *
 *   BASE=http://localhost:4321 EMAIL=vos@ejemplo.com CLAVE=… node scripts/capturas.mjs
 *
 * Las credenciales vienen por entorno y no tienen valor por defecto: un script
 * del repositorio no es lugar para un usuario ni para una contraseña.
 * ========================================================================== */

const BASE = process.env.BASE ?? 'http://localhost:4321'
const EMAIL = process.env.EMAIL
const CLAVE = process.env.CLAVE
const SALIDA = process.env.SALIDA ?? 'capturas'

if (!EMAIL || !CLAVE) {
  console.error('Faltan EMAIL y CLAVE en el entorno.')
  console.error('Uso: EMAIL=vos@ejemplo.com CLAVE=… node scripts/capturas.mjs')
  process.exit(1)
}

mkdirSync(SALIDA, { recursive: true })

async function entrar(pagina) {
  await pagina.goto(`${BASE}/login`)
  await pagina.fill('#email', EMAIL)
  await pagina.fill('#contrasenia', CLAVE)
  await pagina.click('button[type=submit]')
  await pagina.waitForURL('**/dashboard**')
}

const navegador = await chromium.launch()

const ctx = await navegador.newContext({
  ...devices['Desktop Chrome'],
  viewport: { width: 1440, height: 1000 },
})
const p = await ctx.newPage()

await entrar(p)
await p.waitForTimeout(2500)

for (const tema of ['claro', 'oscuro']) {
  await p.evaluate((t) => {
    localStorage.setItem('vmstats:tema', t)
    document.documentElement.classList.toggle('dark', t === 'oscuro')
  }, tema)
  await p.waitForTimeout(400)

  for (const [vista, etiqueta] of [
    ['overview', 'resumen'],
    ['resources', 'recursos'],
    ['containers', 'contenedores'],
  ]) {
    await p.goto(`${BASE}/dashboard?view=${vista}`)
    await p.waitForTimeout(2000)
    await p.screenshot({ path: `${SALIDA}/${etiqueta}-${tema}.png`, fullPage: false })
  }
}

// Móvil
const m = await navegador.newContext({ ...devices['iPhone 13'] })
const pm = await m.newPage()

await entrar(pm)
await pm.waitForTimeout(2000)
await pm.screenshot({ path: `${SALIDA}/movil-resumen.png` })

await pm.goto(`${BASE}/dashboard?view=containers`)
await pm.waitForTimeout(1500)
await pm.screenshot({ path: `${SALIDA}/movil-contenedores.png` })

await navegador.close()
console.log('capturas listas en', SALIDA)
