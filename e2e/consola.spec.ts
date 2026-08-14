import { expect, test } from '@playwright/test'
import { ANCHOS, culpablesDeDesborde, desbordaHorizontal, entrar, irASeccion } from './ayudas'

/* ============================================================================
 * End-to-end de la consola.
 *
 * Estos tests existen sobre todo por dos cosas que ninguna otra verificación
 * detecta:
 *
 *  - Que las islas de React hidraten. El CSP tiene que permitir los scripts
 *    inline con los que Astro hidrata; si no, la página se sirve entera y con
 *    buena pinta, pero ningún control responde. Un `curl` no lo ve.
 *  - Que no haya scroll horizontal en los cuatro anchos, que es una regla dura
 *    del proyecto y se rompe con un solo `min-w` mal puesto.
 * ========================================================================== */

const SECCIONES = ['Resumen', 'Recursos', 'Contenedores', 'Despliegues', 'Alertas', 'Historial']

test.describe('acceso', () => {
  test('sin sesión, el dashboard redirige al login', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible()
  })

  test('una contraseña incorrecta no distingue de un usuario inexistente', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('no-existe@vmstats.local')
    await page.getByLabel('Contraseña').fill('cualquier-cosa')
    await page.getByRole('button', { name: 'Entrar' }).click()

    const mensaje = page.getByRole('alert')
    await expect(mensaje).toBeVisible()
    await expect(mensaje).toContainText('Email o contraseña incorrectos')
  })

  test('las credenciales nunca aparecen en la URL', async ({ page }) => {
    /* Regresión de un fallo real, encontrado desplegando.
     *
     * El formulario se manda por `fetch`, pero entre que el servidor pinta el
     * HTML y React engancha el `onSubmit` hay una ventana. Un submit dentro de
     * esa ventana es nativo, y sin `method` el nativo es GET: la contraseña
     * terminaba en la query string, o sea en el historial del navegador, en los
     * logs del proxy y en el `Referer` del pedido siguiente.
     *
     * Se envía a propósito lo más rápido posible —Enter apenas existe el campo,
     * sin esperar hidratación— porque es justo la carrera que hay que perder
     * sin filtrar nada. */
    await page.goto('/login')
    await page.locator('#email').fill('quien@ejemplo.com')
    await page.locator('#contrasenia').fill('secreto-que-no-debe-viajar')
    await page.locator('#contrasenia').press('Enter')
    await page.waitForTimeout(2500)

    const url = page.url()
    expect(url).not.toContain('secreto-que-no-debe-viajar')
    expect(url).not.toContain('contrasenia=')
    expect(url).not.toContain('quien%40ejemplo.com')

    // Y el formulario declara POST, que es la garantía de fondo: aunque el
    // envío nativo ocurra, los campos van en el cuerpo.
    await expect(page.locator('form')).toHaveAttribute('method', /post/i)
  })

  test('se entra y se sale', async ({ page }) => {
    await entrar(page)
    await expect(page.getByRole('tablist', { name: 'Secciones' })).toBeVisible()

    await page.getByRole('button', { name: 'Salir' }).click()
    await page.waitForURL('**/login**')
  })
})

test.describe('hidratación', () => {
  test('las islas de React hidratan sin errores de consola', async ({ page }) => {
    const errores: string[] = []
    // Una violación de CSP llega como error de consola. Es la señal exacta que
    // buscamos: si el CSP bloquea la hidratación, aparece acá.
    page.on('console', (mensaje) => {
      if (mensaje.type() === 'error') errores.push(mensaje.text())
    })
    page.on('pageerror', (causa) => errores.push(causa.message))

    await entrar(page)
    await page.waitForTimeout(1500)

    expect(errores.filter((e) => /content security policy|refused to execute/i.test(e))).toEqual([])
    expect(errores).toEqual([])
  })

  test('cambiar de pestaña actualiza la URL y el contenido', async ({ page }) => {
    await entrar(page)

    await irASeccion(page, 'Contenedores')
    await expect(page).toHaveURL(/view=containers/)
    await expect(page.getByRole('tab', { name: 'Contenedores' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await irASeccion(page, 'Alertas')
    await expect(page).toHaveURL(/view=alerts/)
  })

  test('la vista de la URL sobrevive a un recargo', async ({ page }) => {
    await entrar(page)
    await page.goto('/dashboard?view=deployments')
    await expect(page.getByRole('tab', { name: 'Despliegues' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('el tema alterna y persiste', async ({ page }) => {
    await entrar(page)

    const oscuroAlPrincipio = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )

    await page.getByRole('button', { name: /Cambiar a tema/ }).click()
    await page.waitForTimeout(200)

    const oscuroDespues = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )
    expect(oscuroDespues).toBe(!oscuroAlPrincipio)

    // Tras recargar tiene que seguir igual, y sin parpadeo: el script del
    // `<head>` lo aplica antes del primer pintado.
    await page.reload()
    const oscuroTrasRecargar = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )
    expect(oscuroTrasRecargar).toBe(oscuroDespues)
  })
})

test.describe('sin scroll horizontal', () => {
  for (const ancho of ANCHOS) {
    test(`a ${ancho} px, en todas las secciones`, async ({ page }) => {
      await page.setViewportSize({ width: ancho, height: 900 })
      await entrar(page)

      for (const seccion of SECCIONES) {
        await irASeccion(page, seccion)

        const desborda = await desbordaHorizontal(page)
        if (desborda) {
          const culpables = await culpablesDeDesborde(page)
          throw new Error(
            `Scroll horizontal en "${seccion}" a ${ancho} px. Elementos que se pasan:\n` +
              culpables.map((c) => `  - ${c}`).join('\n'),
          )
        }
      }
    })
  }

  test('tampoco con el inspector lateral abierto', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 })
    await entrar(page)
    await irASeccion(page, 'Contenedores')

    const primero = page.locator('main button').filter({ hasText: /vmstats|tienda/ }).first()
    if ((await primero.count()) > 0) {
      await primero.click()
      await page.waitForTimeout(600)
      expect(await desbordaHorizontal(page)).toBe(false)
    }
  })
})

test.describe('accesibilidad', () => {
  test('la navegación es un tablist con estado', async ({ page }) => {
    await entrar(page)

    const pestanias = page.getByRole('tab')
    await expect(pestanias).toHaveCount(SECCIONES.length)

    // Exactamente una seleccionada.
    const seleccionadas = page.locator('[role="tab"][aria-selected="true"]')
    await expect(seleccionadas).toHaveCount(1)
  })

  test('el salto al contenido es el primer foco del dashboard', async ({ page }) => {
    // Se prueba en el dashboard y no en el login: allá el campo de email
    // toma el foco al cargar, que es lo correcto para un formulario de una
    // sola cosa, y por lo tanto el primer Tab ya no es el salto.
    await entrar(page)
    await page.evaluate(() => document.body.focus())
    await page.keyboard.press('Tab')

    const enfocado = await page.evaluate(() => document.activeElement?.textContent?.trim())
    expect(enfocado).toBe('Saltar al contenido')

    // Y llevar al contenido de verdad, no a un ancla muerta.
    await page.keyboard.press('Enter')
    await expect(page.locator('#contenido')).toBeVisible()
  })

  test('el inspector atrapa el foco y lo devuelve al cerrar', async ({ page }) => {
    await entrar(page)
    await irASeccion(page, 'Contenedores')

    const fila = page.locator('main tbody tr').first()
    if ((await fila.count()) === 0) test.skip(true, 'sin contenedores en la instancia de prueba')

    await fila.click()
    await page.waitForTimeout(600)

    const dialogo = page.getByRole('dialog')
    await expect(dialogo).toBeVisible()
    await expect(dialogo).toHaveAttribute('data-open', 'true')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)

    /* El panel sigue en el DOM: hace falta para que la transición de salida se
     * vea. Lo que tiene que cumplirse es que quede fuera del alcance — `inert`
     * lo saca del árbol de accesibilidad y del orden de tabulación, que es la
     * garantía real. `toBeHidden` no sirve acá porque mide `visibility` y el
     * panel se oculta por transform y opacidad. */
    await expect(dialogo).toHaveAttribute('data-open', 'false')
    await expect(dialogo).toHaveAttribute('inert', '')

    // Y el foco volvió al contenido, no se perdió al principio del documento.
    const enBody = await page.evaluate(() => document.activeElement === document.body)
    expect(enBody).toBe(false)
  })

  test('los gráficos tienen alternativa en tabla', async ({ page }) => {
    await entrar(page)
    await irASeccion(page, 'Recursos')
    await page.waitForTimeout(1500)

    const boton = page.getByRole('button', { name: 'Ver como tabla' }).first()
    await expect(boton).toBeVisible()
    await boton.click()
    await expect(page.getByRole('button', { name: 'Ocultar tabla' }).first()).toBeVisible()
  })
})

test.describe('tiempo real', () => {
  test('el estado de conexión llega a «En vivo»', async ({ page }) => {
    await entrar(page)
    // El SSE tarda un instante en enganchar; el estado arranca en «Conectando».
    await expect(page.getByText('En vivo')).toBeVisible({ timeout: 15_000 })
  })

  test('el SSE reconecta solo cuando se corta la red', async ({ page, context }) => {
    // Detectar el silencio son 50 s por diseño, más el backoff de la vuelta.
    // No se puede acortar sin volver la detección susceptible a un latido
    // perdido por un pico de carga.
    test.setTimeout(180_000)

    /* Se corta la red del navegador, no una ruta.
     *
     * `page.route` sólo intercepta peticiones nuevas, y el stream ya está
     * abierto: abortar la ruta no lo mata. `setOffline` sí tira la conexión
     * viva, que es lo que pasa en la realidad — un túnel que se cae, un wifi
     * que se corta.
     *
     * El backoff propio es 1s, 2s, 4s… y tras cuatro fallos pasa a polling; el
     * test acepta cualquiera de los dos estados intermedios.
     *
     * La espera es de 60 s y no de 20 porque cortar la red no siempre cierra el
     * socket: contra un servidor remoto queda ABIERTO pero mudo, y ahí
     * `EventSource` no emite `error`. Lo que lo detecta es la vigilancia del
     * latido, que da por muerto el túnel tras 50 s de silencio —dos latidos y
     * medio—. Ese caso es justamente el que este test existe para cubrir: sin
     * la vigilancia, la consola se quedaba en «En vivo» con datos congelados. */
    await entrar(page)
    await expect(page.getByText('En vivo')).toBeVisible({ timeout: 15_000 })

    await context.setOffline(true)

    await expect(page.getByText(/Reconectando|Actualizando cada/)).toBeVisible({
      timeout: 60_000,
    })

    await context.setOffline(false)

    // Y vuelve solo, sin recargar la página.
    await expect(page.getByText('En vivo')).toBeVisible({ timeout: 45_000 })
  })
})

test.describe('enlaces directos', () => {
  /* Cada sección cargada en fresco desde el servidor.
   *
   * Es lo que atrapa las discrepancias de hidratación por vista: `?view=history`
   * renderiza en el servidor el rango de fechas, que depende del reloj y del
   * huso local. Cargar sólo `/dashboard` pelado no lo ejercita. */
  for (const [vista, etiqueta] of [
    ['overview', 'Resumen'],
    ['resources', 'Recursos'],
    ['containers', 'Contenedores'],
    ['deployments', 'Despliegues'],
    ['alerts', 'Alertas'],
    ['history', 'Historial'],
  ] as const) {
    test(`?view=${vista} abre en «${etiqueta}» sin errores de hidratación`, async ({
      page,
    }) => {
      const errores: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') errores.push(m.text())
      })
      page.on('pageerror', (e) => errores.push(e.message))

      await entrar(page)
      await page.goto(`/dashboard?view=${vista}`)
      await page.waitForTimeout(1800)

      await expect(page.getByRole('tab', { name: etiqueta })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(errores).toEqual([])
    })
  }
})
