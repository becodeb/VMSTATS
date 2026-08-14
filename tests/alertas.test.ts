import { describe, expect, it } from 'vitest'
import {
  ESTADO_EVALUACION_INICIAL,
  condicionSeCumple,
  evaluarRegla,
  umbralDeSalida,
  valorDeMetrica,
  type EstadoEvaluacion,
  type ReglaAlerta,
} from '@vmstats/shared'
import { muestraDePrueba } from './fixtures/muestra.js'

/* ============================================================================
 * Máquina de estados de las alertas.
 *
 * El reloj entra por parámetro, así que se pueden recorrer horas de
 * comportamiento sin esperar. Es la única forma razonable de probar cooldowns
 * de diez minutos y duraciones mínimas de cinco.
 * ========================================================================== */

const SEGUNDO = 1000
const MINUTO = 60 * SEGUNDO

function regla(cambios: Partial<ReglaAlerta> = {}): ReglaAlerta {
  return {
    id: 1,
    nombre: 'CPU alta',
    metrica: 'cpu.total',
    operador: 'mayor',
    umbral: 80,
    severidad: 'warning',
    duracionMinimaSegundos: 300,
    cooldownSegundos: 600,
    histeresis: 5,
    habilitada: true,
    silenciadaHasta: null,
    ...cambios,
  }
}

/** Recorre una secuencia de (valor, instante) devolviendo las acciones. */
function correr(
  r: ReglaAlerta,
  pasos: readonly [valor: number, ahora: number][],
  desde: EstadoEvaluacion = ESTADO_EVALUACION_INICIAL,
): { acciones: string[]; estado: EstadoEvaluacion } {
  let estado = desde
  const acciones: string[] = []

  for (const [valor, ahora] of pasos) {
    const resultado = evaluarRegla(r, valor, ahora, estado)
    estado = resultado.estado
    if (resultado.accion.tipo !== 'ninguna') acciones.push(resultado.accion.tipo)
  }

  return { acciones, estado }
}

describe('condición y umbral de salida', () => {
  it('compara según el operador', () => {
    expect(condicionSeCumple(regla(), 85)).toBe(true)
    expect(condicionSeCumple(regla(), 80)).toBe(false)
    expect(condicionSeCumple(regla({ operador: 'menor', umbral: 10 }), 5)).toBe(true)
  })

  it('corre el umbral de salida en la dirección contraria', () => {
    expect(umbralDeSalida(regla({ umbral: 80, histeresis: 5 }))).toBe(75)
    expect(
      umbralDeSalida(regla({ operador: 'menor', umbral: 10, histeresis: 3 })),
    ).toBe(13)
  })
})

describe('duración mínima', () => {
  it('no dispara antes de que se cumpla', () => {
    const { acciones } = correr(regla({ duracionMinimaSegundos: 300 }), [
      [90, 0],
      [90, 100 * SEGUNDO],
      [90, 200 * SEGUNDO],
      [90, 299 * SEGUNDO],
    ])
    expect(acciones).toEqual([])
  })

  it('dispara al alcanzarla', () => {
    const { acciones } = correr(regla({ duracionMinimaSegundos: 300 }), [
      [90, 0],
      [90, 300 * SEGUNDO],
    ])
    expect(acciones).toEqual(['abrir'])
  })

  it('reinicia el reloj si la condición deja de cumplirse', () => {
    const { acciones } = correr(regla({ duracionMinimaSegundos: 300 }), [
      [90, 0],
      [90, 200 * SEGUNDO],
      [50, 250 * SEGUNDO], // baja: el reloj vuelve a cero
      [90, 300 * SEGUNDO],
      [90, 500 * SEGUNDO], // sólo 200 s sostenidos
    ])
    expect(acciones).toEqual([])
  })

  it('dispara al instante con duración mínima cero', () => {
    const { acciones } = correr(regla({ duracionMinimaSegundos: 0 }), [[90, 0]])
    expect(acciones).toEqual(['abrir'])
  })
})

describe('histéresis', () => {
  it('no cierra mientras el valor siga por encima del umbral de salida', () => {
    const r = regla({ duracionMinimaSegundos: 0, umbral: 80, histeresis: 5 })
    const { acciones } = correr(r, [
      [90, 0], // abre
      [79, 1 * MINUTO], // por debajo del umbral, pero por encima de 75
      [76, 2 * MINUTO],
    ])
    expect(acciones).toEqual(['abrir'])
  })

  it('cierra al cruzar el umbral de salida', () => {
    const r = regla({ duracionMinimaSegundos: 0, umbral: 80, histeresis: 5 })
    const { acciones } = correr(r, [
      [90, 0],
      [75, 1 * MINUTO],
    ])
    expect(acciones).toEqual(['abrir', 'resolver'])
  })

  it('evita la ráfaga de un valor que oscila sobre el umbral', () => {
    const r = regla({ duracionMinimaSegundos: 0, cooldownSegundos: 0, umbral: 80, histeresis: 5 })
    const oscilando: [number, number][] = []
    for (let i = 0; i < 20; i += 1) {
      oscilando.push([i % 2 === 0 ? 81 : 79, i * MINUTO])
    }

    const { acciones } = correr(r, oscilando)
    // Sin histéresis serían diez pares abrir/resolver.
    expect(acciones).toEqual(['abrir'])
  })
})

describe('cooldown', () => {
  it('no vuelve a abrir antes de que pase', () => {
    const r = regla({ duracionMinimaSegundos: 0, cooldownSegundos: 600, histeresis: 5 })
    const { acciones } = correr(r, [
      [90, 0], // abre
      [70, 1 * MINUTO], // cierra
      [90, 5 * MINUTO], // dentro del cooldown
      [90, 9 * MINUTO],
    ])
    expect(acciones).toEqual(['abrir', 'resolver'])
  })

  it('vuelve a abrir cuando termina', () => {
    const r = regla({ duracionMinimaSegundos: 0, cooldownSegundos: 600, histeresis: 5 })
    const { acciones } = correr(r, [
      [90, 0],
      [70, 1 * MINUTO],
      [90, 12 * MINUTO], // pasaron 11 minutos desde la resolución
    ])
    expect(acciones).toEqual(['abrir', 'resolver', 'abrir'])
  })
})

describe('silenciamiento', () => {
  it('no dispara mientras está silenciada', () => {
    const r = regla({
      duracionMinimaSegundos: 0,
      silenciadaHasta: new Date(10 * MINUTO).toISOString(),
    })
    const { acciones } = correr(r, [
      [90, 1 * MINUTO],
      [90, 5 * MINUTO],
    ])
    expect(acciones).toEqual([])
  })

  it('dispara sin volver a esperar cuando se levanta el silencio', () => {
    // El reloj de la condición sigue corriendo durante el silencio: si no,
    // levantar el silencio obligaría a esperar otra vez la duración mínima.
    const r = regla({
      duracionMinimaSegundos: 300,
      silenciadaHasta: new Date(10 * MINUTO).toISOString(),
    })
    const { acciones } = correr(r, [
      [90, 0],
      [90, 5 * MINUTO],
      [90, 11 * MINUTO], // ya no está silenciada
    ])
    expect(acciones).toEqual(['abrir'])
  })
})

describe('regla deshabilitada', () => {
  it('no dispara', () => {
    const { acciones } = correr(regla({ habilitada: false, duracionMinimaSegundos: 0 }), [
      [99, 0],
    ])
    expect(acciones).toEqual([])
  })

  it('cierra una alerta que estaba abierta', () => {
    const abierta: EstadoEvaluacion = {
      condicionDesde: 0,
      activaDesde: 0,
      ultimaResolucion: null,
    }
    const { acciones } = correr(regla({ habilitada: false }), [[99, MINUTO]], abierta)
    expect(acciones).toEqual(['resolver'])
  })
})

/* -------------------------------------------------------------------------
 * Extracción de métricas
 * ---------------------------------------------------------------------- */

describe('valorDeMetrica', () => {
  const contexto = { host: muestraDePrueba(), contenedores: [], silencioSegundos: 0 }

  it('lee valores directos', () => {
    expect(valorDeMetrica('cpu.total', contexto)).toBeCloseTo(35.5, 6)
    expect(valorDeMetrica('cpu.steal', contexto)).toBeCloseTo(1.5, 6)
  })

  it('calcula porcentajes derivados', () => {
    // 8 GiB usados de 16 GiB.
    expect(valorDeMetrica('memoria.usadaPorcentaje', contexto)).toBeCloseTo(50, 6)
  })

  it('devuelve null si no hay swap configurada', () => {
    const sinSwap = {
      ...contexto,
      host: muestraDePrueba({ memoria: { swapTotal: 0, swapUsada: 0 } }),
    }
    // Distinto de 0: «no hay swap» no es lo mismo que «hay swap y está vacía».
    expect(valorDeMetrica('memoria.swapPorcentaje', sinSwap)).toBeNull()
  })

  it('devuelve null cuando el kernel no expone PSI', () => {
    const sinPsi = {
      ...contexto,
      host: muestraDePrueba({ presion: { cpu: null, memoria: null, io: null } }),
    }
    expect(valorDeMetrica('presion.cpu', sinPsi)).toBeNull()
  })

  it('toma el filesystem más lleno', () => {
    // 90 % en /var contra 50 % en /.
    expect(valorDeMetrica('disco.usadoPorcentaje', contexto)).toBeCloseTo(90, 6)
  })

  it('normaliza la carga por núcleo', () => {
    // load 2 con 4 núcleos.
    expect(valorDeMetrica('carga.porNucleo', contexto)).toBeCloseTo(0.5, 6)
  })

  it('cuenta contenedores en problemas sin contar los que terminaron bien', () => {
    const conContenedores = {
      ...contexto,
      host: muestraDePrueba({ capacidades: { contenedores: true } }),
      contenedores: [
        { salud: 'unhealthy', estado: 'running' },
        { salud: 'none', estado: 'restarting' },
        { salud: 'none', estado: 'dead' },
        // `exited` es una tarea puntual que terminó: no es un problema.
        { salud: 'none', estado: 'exited' },
        { salud: 'healthy', estado: 'running' },
      ].map((c) => ({ ...contenedorBase, ...c })),
    }
    expect(valorDeMetrica('contenedor.caido', conContenedores)).toBe(3)
  })

  it('devuelve null para contenedores si no hay Docker', () => {
    expect(valorDeMetrica('contenedor.caido', contexto)).toBeNull()
  })
})

const contenedorBase = {
  hostId: 'h',
  contenedorId: 'abc123456789',
  ts: new Date(0).toISOString(),
  nombre: 'x',
  imagen: 'i',
  estado: 'running' as const,
  salud: 'none' as const,
  cpuPorcentaje: 0,
  memoriaBytes: 0,
  memoriaLimiteBytes: null,
  redRxBytesPorSeg: 0,
  redTxBytesPorSeg: 0,
  bloqueLecturaBytesPorSeg: 0,
  bloqueEscrituraBytesPorSeg: 0,
  uptimeSegundos: 0,
  reinicios: 0,
  puertos: [],
  coolifyAplicacion: null,
  coolifyUuid: null,
}

describe('disco: filesystems llenos por diseño', () => {
  it('no los toma como el filesystem más lleno', () => {
    // Sin esto, cualquier Ubuntu con snaps tendría una alerta crítica de disco
    // permanente e irresoluble.
    const contexto = {
      host: muestraDePrueba({
        filesystems: [
          {
            puntoMontaje: '/snap/core22/1',
            dispositivo: '/dev/loop0',
            tipo: 'squashfs',
            tamanio: 100,
            usado: 100,
            disponible: 0,
            inodosTotal: null,
            inodosUsados: null,
          },
          {
            puntoMontaje: '/',
            dispositivo: '/dev/sda1',
            tipo: 'ext4',
            tamanio: 100,
            usado: 40,
            disponible: 60,
            inodosTotal: null,
            inodosUsados: null,
          },
        ],
      }),
      contenedores: [],
      silencioSegundos: 0,
    }

    expect(valorDeMetrica('disco.usadoPorcentaje', contexto)).toBeCloseTo(40, 6)
  })
})
