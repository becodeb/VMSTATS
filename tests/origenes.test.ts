import { describe, expect, it } from 'vitest'
import { origenValido, parsearOrigenes } from '../apps/web/src/lib/seguridad.js'

/* ============================================================================
 * Validación de `Origin`.
 *
 * Es la segunda barrera del CSRF, independiente del token firmado. Importa
 * afinarla porque falla en las dos direcciones: de más, y un sitio ajeno puede
 * mutar estado; de menos, y nadie puede iniciar sesión —que fue justo lo que
 * pasó al publicar la consola bajo dos nombres a la vez—.
 * ========================================================================== */

const SITIO = new URL('https://consola.ejemplo.com/api/alertas')

function pedido(cabeceras: Record<string, string>): Request {
  return new Request('https://consola.ejemplo.com/api/alertas', {
    method: 'POST',
    headers: cabeceras,
  })
}

describe('parsearOrigenes', () => {
  it('separa por coma y limpia espacios', () => {
    expect(parsearOrigenes('https://a.com, https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('saca la barra final para que las dos formas coincidan', () => {
    // Un operador que copia la URL del navegador la pega con barra.
    expect(parsearOrigenes('https://a.com/')).toEqual(['https://a.com'])
    expect(parsearOrigenes('https://a.com///')).toEqual(['https://a.com'])
  })

  it('descarta entradas vacías', () => {
    // Si quedara una cadena vacía en la lista, un `Origin: ''` pasaría.
    expect(parsearOrigenes('https://a.com,')).toEqual(['https://a.com'])
    expect(parsearOrigenes(',,  ,')).toEqual([])
    expect(parsearOrigenes('')).toEqual([])
  })
})

describe('origenValido con lista configurada', () => {
  const permitidos = ['https://consola.ejemplo.com', 'https://consola.198.51.100.7.sslip.io']

  it('acepta cualquiera de los configurados', () => {
    for (const origen of permitidos) {
      expect(origenValido(pedido({ origin: origen }), SITIO, permitidos)).toBe(true)
    }
  })

  it('rechaza uno que no está', () => {
    expect(origenValido(pedido({ origin: 'https://malicioso.com' }), SITIO, permitidos)).toBe(
      false,
    )
  })

  it('rechaza un subdominio parecido', () => {
    // La comparación es exacta, no por sufijo: si no,
    // `consola.ejemplo.com.malicioso.com` pasaría.
    expect(
      origenValido(
        pedido({ origin: 'https://consola.ejemplo.com.malicioso.com' }),
        SITIO,
        permitidos,
      ),
    ).toBe(false)
  })

  it('rechaza el mismo host por http', () => {
    expect(
      origenValido(pedido({ origin: 'http://consola.ejemplo.com' }), SITIO, permitidos),
    ).toBe(false)
  })

  it('rechaza un Origin vacío', () => {
    expect(origenValido(pedido({ origin: '' }), SITIO, permitidos)).toBe(false)
  })
})

describe('origenValido sin Origin', () => {
  const permitidos = ['https://consola.ejemplo.com']

  it('acepta un cliente que no manda Origin ni Referer', () => {
    // Es el caso de curl o de un script con una clave de API: no hay navegador
    // que pueda ser engañado, así que el ataque que cubre el CSRF no aplica.
    expect(origenValido(pedido({}), SITIO, permitidos)).toBe(true)
  })

  it('rechaza si el Referer viene de otro sitio', () => {
    expect(
      origenValido(pedido({ referer: 'https://malicioso.com/x' }), SITIO, permitidos),
    ).toBe(false)
  })

  it('acepta si el Referer es del propio sitio', () => {
    expect(
      origenValido(
        pedido({ referer: 'https://consola.ejemplo.com/dashboard' }),
        SITIO,
        permitidos,
      ),
    ).toBe(true)
  })

  it('rechaza un Referer que no es una URL', () => {
    expect(origenValido(pedido({ referer: 'no-es-una-url' }), SITIO, permitidos)).toBe(false)
  })
})

describe('origenValido sin lista configurada', () => {
  it('cae al origen del propio pedido', () => {
    expect(
      origenValido(pedido({ origin: 'https://consola.ejemplo.com' }), SITIO, []),
    ).toBe(true)
    expect(origenValido(pedido({ origin: 'https://otro.com' }), SITIO, [])).toBe(false)
  })
})
