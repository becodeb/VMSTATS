import { describe, expect, it } from 'vitest'
import { MARCA_REDACTADO, redactar, redactarLineas } from '@vmstats/shared'
import { limpiarTexto, parsearLineas, separarFlujos } from '../apps/collector/src/docker/logs.js'
import { Buffer } from 'node:buffer'

/* ============================================================================
 * Redacción de secretos y saneado de logs.
 *
 * Los logs de contenedor son texto que controla un tercero y que se muestra en
 * el navegador. Estos tests son la línea que separa «mostrar un log» de
 * «filtrar la contraseña de la base en pantalla».
 * ========================================================================== */

/** No queda rastro del secreto en la salida. */
function noContiene(texto: string, secreto: string): boolean {
  return !texto.includes(secreto)
}

describe('redactar', () => {
  it('tapa contraseñas en clave=valor', () => {
    const r = redactar('DB_PASSWORD=superclave123 arrancando')
    expect(noContiene(r.texto, 'superclave123')).toBe(true)
    expect(r.texto).toContain(MARCA_REDACTADO)
    expect(r.redacciones).toBe(1)
  })

  it('conserva el nombre de la clave', () => {
    // Saber que existe DB_PASSWORD sirve para operar; el valor no.
    const r = redactar('DB_PASSWORD=superclave123')
    expect(r.texto).toContain('DB_PASSWORD')
  })

  it('cubre las variantes habituales del nombre', () => {
    for (const clave of [
      'password',
      'passwd',
      'PWD',
      'api_key',
      'apiKey',
      'ACCESS_KEY',
      'secret',
      'TOKEN',
      'private_key',
      'credential',
    ]) {
      const r = redactar(`${clave}=valorsecretisimo`)
      expect(noContiene(r.texto, 'valorsecretisimo'), `falló con ${clave}`).toBe(true)
    }
  })

  it('tapa credenciales embebidas en una URL', () => {
    const r = redactar('conectando a postgres://usuario:miclave@db:5432/vmstats')
    expect(noContiene(r.texto, 'miclave')).toBe(true)
    // El resto de la URL sigue siendo útil para diagnosticar.
    expect(r.texto).toContain('db:5432')
    expect(r.texto).toContain('usuario')
  })

  it('tapa cabeceras Authorization', () => {
    const bearer = redactar('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef')
    expect(noContiene(bearer.texto, 'eyJhbGciOiJIUzI1NiJ9abcdef')).toBe(true)

    const basico = redactar('authorization: Basic dXN1YXJpbzpjbGF2ZQ==')
    expect(noContiene(basico.texto, 'dXN1YXJpbzpjbGF2ZQ')).toBe(true)
  })

  it('tapa JWTs sueltos', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const r = redactar(`token recibido ${jwt}`)
    expect(noContiene(r.texto, jwt)).toBe(true)
  })

  it('tapa claves con prefijo reconocible', () => {
    for (const clave of [
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      const r = redactar(`usando ${clave} para conectar`)
      expect(noContiene(r.texto, clave), `falló con ${clave}`).toBe(true)
    }
  })

  it('tapa bloques PEM', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const r = redactar(pem)
    expect(noContiene(r.texto, 'MIIEowIBAAKCAQEA')).toBe(true)
  })

  it('no toca texto inocente', () => {
    const normal = 'GET /api/salud 200 en 3ms'
    const r = redactar(normal)
    expect(r.texto).toBe(normal)
    expect(r.redacciones).toBe(0)
  })

  it('acumula el conteo sobre varias líneas', () => {
    const r = redactarLineas([
      'PASSWORD=uno',
      'todo bien',
      'API_KEY=dos',
    ])
    expect(r.redacciones).toBe(2)
    expect(r.lineas[1]).toBe('todo bien')
  })
})

/* -------------------------------------------------------------------------
 * Stream de logs de Docker
 * ---------------------------------------------------------------------- */

/** Arma una trama multiplexada como la que manda Docker sin TTY. */
function trama(tipo: 1 | 2, texto: string): Buffer {
  const carga = Buffer.from(texto, 'utf8')
  const cabecera = Buffer.alloc(8)
  cabecera[0] = tipo
  cabecera.writeUInt32BE(carga.length, 4)
  return Buffer.concat([cabecera, carga])
}

describe('separarFlujos', () => {
  it('separa stdout de stderr', () => {
    const cuerpo = Buffer.concat([
      trama(1, 'linea de salida\n'),
      trama(2, 'linea de error\n'),
      trama(1, 'otra de salida\n'),
    ])

    const fragmentos = separarFlujos(cuerpo)
    expect(fragmentos).toHaveLength(3)
    expect(fragmentos[0]?.flujo).toBe('stdout')
    expect(fragmentos[1]?.flujo).toBe('stderr')
    expect(fragmentos[1]?.texto).toBe('linea de error\n')
  })

  it('trata como texto plano la salida de un contenedor con TTY', () => {
    const fragmentos = separarFlujos(Buffer.from('salida sin multiplexar\n', 'utf8'))
    expect(fragmentos).toHaveLength(1)
    expect(fragmentos[0]?.flujo).toBe('stdout')
    expect(fragmentos[0]?.texto).toContain('salida sin multiplexar')
  })

  it('no rompe con un buffer vacío', () => {
    expect(separarFlujos(Buffer.alloc(0))).toEqual([])
  })
})

describe('parsearLineas', () => {
  it('separa la marca de tiempo del texto', () => {
    const lineas = parsearLineas([
      { flujo: 'stdout', texto: '2026-01-01T10:00:00.123456789Z arrancando\n' },
    ])
    expect(lineas[0]?.ts).toBe('2026-01-01T10:00:00.123Z')
    expect(lineas[0]?.texto).toBe('arrancando')
  })

  it('acepta líneas sin marca de tiempo', () => {
    const lineas = parsearLineas([{ flujo: 'stdout', texto: 'sin fecha\n' }])
    expect(lineas[0]?.ts).toBeNull()
    expect(lineas[0]?.texto).toBe('sin fecha')
  })
})

describe('limpiarTexto', () => {
  const ESC = String.fromCharCode(27)

  it('quita colores ANSI', () => {
    expect(limpiarTexto(`${ESC}[31mrojo${ESC}[0m`)).toBe('rojo')
  })

  it('quita movimientos de cursor', () => {
    expect(limpiarTexto(`antes${ESC}[2Kdespues`)).toBe('antesdespues')
  })

  it('quita el retorno de carro, que permite tapar la línea anterior', () => {
    const falseando = `todo bien${String.fromCharCode(13)}ERROR CRITICO`
    expect(limpiarTexto(falseando)).toBe('todo bienERROR CRITICO')
  })

  it('conserva el tabulador', () => {
    expect(limpiarTexto('col1\tcol2')).toBe('col1\tcol2')
  })

  it('no toca los corchetes normales', () => {
    expect(limpiarTexto('array[0] = {clave: valor}')).toBe('array[0] = {clave: valor}')
  })

  it('quita un ESC suelto y el DEL', () => {
    expect(limpiarTexto(`a${ESC}b${String.fromCharCode(127)}c`)).toBe('abc')
  })
})
