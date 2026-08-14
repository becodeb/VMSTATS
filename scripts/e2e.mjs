#!/usr/bin/env node
/* ============================================================================
 * Prepara el entorno de los tests end-to-end y los corre.
 *
 * Los E2E de vmstats no se pueden lanzar con `playwright test` a secas: hacen
 * falta PostgreSQL con migraciones, un usuario para entrar, y datos de un
 * collector. Este script arma todo eso contra el compose y después delega en
 * Playwright.
 *
 *   node scripts/e2e.mjs               # levanta el compose y corre los tests
 *   node scripts/e2e.mjs --sin-levantar  # usa lo que ya esté corriendo
 *
 * Es lo que `playwright.config.ts` menciona en su comentario, y la razón por la
 * que ese archivo NO define `webServer`: un `webServer` daría la falsa
 * impresión de que alcanza con el proceso de Astro.
 * ========================================================================== */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const EMAIL = process.env['E2E_EMAIL'] ?? 'e2e@vmstats.local'
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'clave-de-prueba-e2e-12345'
const levantar = !process.argv.includes('--sin-levantar')

function correr(comando, args, opciones = {}) {
  const r = spawnSync(comando, args, { stdio: 'inherit', shell: true, ...opciones })
  if (r.status !== 0) {
    console.error(`\nFalló: ${comando} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
  return r
}

function capturar(comando, args) {
  const r = spawnSync(comando, args, { encoding: 'utf8', shell: true })
  return (r.stdout ?? '').trim()
}

/** Puerto publicado por el compose, para no adivinarlo. */
function puerto() {
  if (process.env['VMSTATS_PUERTO'] !== undefined) return process.env['VMSTATS_PUERTO']
  if (existsSync('.env')) {
    const linea = readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('VMSTATS_PUERTO='))
    if (linea !== undefined) return linea.split('=')[1]?.trim() ?? '4321'
  }
  return '4321'
}

if (!existsSync('.env')) {
  console.error('Falta `.env`. Copiá `.env.example` y completá los secretos.')
  process.exit(1)
}

if (levantar) {
  console.log('== Levantando el compose ==')
  correr('docker', ['compose', 'up', '-d', '--build'])

  console.log('\n== Esperando a que web esté sano ==')
  for (let intento = 0; intento < 60; intento += 1) {
    const estado = capturar('docker', [
      'compose',
      'ps',
      'web',
      '--format',
      '"{{.Status}}"',
    ])
    if (estado.includes('healthy')) break
    if (intento === 59) {
      console.error('web no llegó a estar sano. Revisá `docker compose logs web`.')
      process.exit(1)
    }
    spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'sleep', '2'], { shell: true })
  }
}

console.log('\n== Creando el usuario de prueba (si no existe) ==')
spawnSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    '-e',
    `VMSTATS_ADMIN_EMAIL=${EMAIL}`,
    '-e',
    `VMSTATS_ADMIN_PASSWORD=${PASSWORD}`,
    '-e',
    'VMSTATS_ADMIN_NOMBRE=E2E',
    'web',
    'node',
    'packages/db/dist/bootstrap.js',
  ],
  { stdio: 'inherit', shell: true },
)

const base = `http://localhost:${puerto()}`
console.log(`\n== Corriendo los tests contra ${base} ==\n`)

correr('npx', ['playwright', 'test', ...process.argv.slice(2).filter((a) => a !== '--sin-levantar')], {
  env: {
    ...process.env,
    E2E_BASE_URL: base,
    E2E_EMAIL: EMAIL,
    E2E_PASSWORD: PASSWORD,
  },
})
