import { defineConfig, devices } from '@playwright/test'

/* ============================================================================
 * Configuración de los tests end-to-end.
 *
 * No levanta el servidor con `webServer`: vmstats necesita PostgreSQL con
 * migraciones aplicadas, un usuario creado y el collector corriendo. Todo eso
 * lo arma `scripts/e2e.mjs`, que es lo que hay que ejecutar. Un `webServer`
 * acá daría la falsa impresión de que basta con `playwright test`.
 * ========================================================================== */

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:4321'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  workers: 1,
  reporter: process.env['CI'] === 'true' ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  timeout: 30_000,
  expect: { timeout: 10_000 },
})
