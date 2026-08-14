import type { Page } from '@playwright/test'

/* ============================================================================
 * Utilidades compartidas de los tests end-to-end.
 * ========================================================================== */

export const CREDENCIALES = {
  email: process.env['E2E_EMAIL'] ?? 'e2e@vmstats.local',
  contrasenia: process.env['E2E_PASSWORD'] ?? 'clave-de-prueba-e2e-12345',
}

/** Los cuatro anchos que la spec exige verificar. */
export const ANCHOS = [360, 768, 1280, 1920] as const

export async function entrar(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(CREDENCIALES.email)
  await page.getByLabel('Contraseña').fill(CREDENCIALES.contrasenia)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.waitForURL('**/dashboard**')
}

/**
 * ¿La página desborda horizontalmente?
 *
 * Es la comprobación literal que pide la spec. Se mide después de que la
 * página quedó quieta: medir durante una transición da falsos positivos porque
 * un panel que está entrando todavía está fuera de la pantalla.
 */
export async function desbordaHorizontal(page: Page): Promise<boolean> {
  await page.waitForTimeout(400)
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
}

/** Qué elemento se está pasando de ancho, para que el fallo diga dónde mirar. */
export async function culpablesDeDesborde(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limite = document.documentElement.clientWidth
    const culpables: string[] = []

    for (const elemento of document.querySelectorAll('*')) {
      const caja = elemento.getBoundingClientRect()
      if (caja.width === 0 || caja.height === 0) continue
      if (caja.right > limite + 1 || caja.left < -1) {
        const clases =
          typeof elemento.className === 'string' ? elemento.className.slice(0, 60) : ''
        culpables.push(
          `${elemento.tagName.toLowerCase()}.${clases} (izq ${Math.round(
            caja.left,
          )}, der ${Math.round(caja.right)}, límite ${limite})`,
        )
      }
    }

    return culpables.slice(0, 8)
  })
}

/** Cambia de sección por la navegación líquida y espera a que el panel exista. */
export async function irASeccion(page: Page, etiqueta: string): Promise<void> {
  await page.getByRole('tab', { name: etiqueta }).click()
  await page.waitForTimeout(300)
}
