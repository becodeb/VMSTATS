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

/**
 * Espera a que las islas de React estén enganchadas.
 *
 * Astro marca cada isla con el atributo `ssr` mientras está sin hidratar y se
 * lo saca al terminar. Esperar eso es esperar exactamente lo que importa: que
 * los controles respondan.
 *
 * Hace falta porque estos tests corren también contra un servidor remoto, donde
 * la hidratación tarda entre 90 y 280 ms —medido— en vez de ser instantánea
 * como en local. Sin esta espera, Playwright hace clic en una pestaña que
 * todavía es HTML muerto y el clic se pierde en silencio: el test falla con un
 * «sigue en Resumen» que no dice nada de la causa.
 *
 * No enmascara un problema del producto: 90–280 ms está por debajo del tiempo
 * que tarda una persona en ubicar y apretar un control. El que hace clic tan
 * rápido es el robot.
 */
export async function esperarHidratacion(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const islas = document.querySelectorAll('astro-island')
    return islas.length > 0 && Array.from(islas).every((i) => !i.hasAttribute('ssr'))
  })
}

export async function entrar(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(CREDENCIALES.email)
  await page.getByLabel('Contraseña').fill(CREDENCIALES.contrasenia)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.waitForURL('**/dashboard**')
  await esperarHidratacion(page)
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
  await esperarHidratacion(page)
  await page.getByRole('tab', { name: etiqueta }).click()
  // Se confirma por el estado y no por un tiempo fijo: si el clic se perdiera,
  // el fallo dice «la pestaña no quedó seleccionada» en vez de reventar más
  // tarde en una aserción que no tiene que ver.
  await page.getByRole('tab', { name: etiqueta }).and(page.locator('[aria-selected="true"]')).waitFor()
  await page.waitForTimeout(300)
}
