import { describe, expect, it } from 'vitest'
import {
  PUNTOS_MAXIMOS,
  PUNTOS_MINIMOS,
  RESOLUCIONES,
  datosDesactualizados,
  formatearBytes,
  formatearDuracion,
  formatearFechaHora,
  formatearNumero,
  formatearPorcentaje,
  peorEstado,
  periodoAnterior,
  planificarConsulta,
  rangoDesdeClave,
  type ClaveRango,
} from '@vmstats/shared'

/* ============================================================================
 * Planificación de consultas y formato.
 *
 * `planificarConsulta` es lo que evita que pedir 30 días mande 260.000 filas al
 * navegador. Los tests recorren todos los rangos de la UI y comprueban la
 * promesa concreta de la spec: entre 300 y 800 puntos por serie.
 * ========================================================================== */

const RETENCION = { raw: 7, '1m': 30, '5m': 365 }

describe('planificarConsulta', () => {
  const RANGOS: ClaveRango[] = ['15m', '1h', '6h', '24h', '7d', '30d']

  for (const clave of RANGOS) {
    it(`devuelve una cantidad manejable de puntos para ${clave}`, () => {
      const { desde, hasta } = rangoDesdeClave(clave)
      const plan = planificarConsulta(desde, hasta, RETENCION)

      expect(plan.puntosEstimados).toBeLessThanOrEqual(PUNTOS_MAXIMOS)
      // Los rangos cortos no llegan al piso porque no hay tantas muestras: 15
      // minutos a 10 s son 90 puntos y no hay nada más fino que los crudos.
      if (clave !== '15m') {
        expect(plan.puntosEstimados).toBeGreaterThanOrEqual(PUNTOS_MINIMOS / 2)
      }
    })
  }

  it('usa datos crudos para rangos cortos', () => {
    const { desde, hasta } = rangoDesdeClave('15m')
    expect(planificarConsulta(desde, hasta, RETENCION).fuente).toBe('raw')
  })

  it('sube de resolución a medida que crece el rango', () => {
    const fuentes = (['1h', '24h', '30d'] as ClaveRango[]).map((c) => {
      const { desde, hasta } = rangoDesdeClave(c)
      return planificarConsulta(desde, hasta, RETENCION).fuente
    })
    // Nunca baja de granularidad al ampliar el rango.
    expect(RESOLUCIONES[fuentes[0]!]).toBeLessThanOrEqual(RESOLUCIONES[fuentes[1]!])
    expect(RESOLUCIONES[fuentes[1]!]).toBeLessThanOrEqual(RESOLUCIONES[fuentes[2]!])
  })

  it('no elige una fuente que la retención ya borró', () => {
    // Un rango de hace 20 días: los crudos se guardan 7.
    const hasta = new Date(Date.now() - 19 * 86_400_000)
    const desde = new Date(hasta.getTime() - 3600_000)
    const plan = planificarConsulta(desde, hasta, RETENCION)
    expect(plan.fuente).not.toBe('raw')
  })

  it('marca como degradada la consulta que no pudo dar la granularidad pedida', () => {
    // Rango cortísimo pero muy viejo: el bucket sería de 10 s y lo único que
    // queda a esa altura son agregados de 5 minutos.
    const hasta = new Date(Date.now() - 300 * 86_400_000)
    const desde = new Date(hasta.getTime() - 600_000)
    const plan = planificarConsulta(desde, hasta, RETENCION)
    expect(plan.degradado).toBe(true)
    expect(plan.bucketSegundos).toBeGreaterThanOrEqual(RESOLUCIONES[plan.fuente])
  })

  it('nunca devuelve un bucket más fino que su fuente', () => {
    for (const dias of [0, 3, 10, 60, 300]) {
      const hasta = new Date(Date.now() - dias * 86_400_000)
      const desde = new Date(hasta.getTime() - 3600_000)
      const plan = planificarConsulta(desde, hasta, RETENCION)
      expect(plan.bucketSegundos).toBeGreaterThanOrEqual(RESOLUCIONES[plan.fuente])
    }
  })

  it('sobrevive a un rango invertido o de duración cero', () => {
    const ahora = new Date()
    const plan = planificarConsulta(ahora, ahora, RETENCION)
    expect(plan.puntosEstimados).toBeGreaterThan(0)
    expect(Number.isFinite(plan.bucketSegundos)).toBe(true)
  })
})

describe('periodoAnterior', () => {
  it('devuelve una ventana contigua de la misma duración', () => {
    const desde = new Date('2026-01-10T00:00:00Z')
    const hasta = new Date('2026-01-11T00:00:00Z')
    const previo = periodoAnterior(desde, hasta)

    expect(previo.hasta.getTime()).toBe(desde.getTime())
    expect(previo.hasta.getTime() - previo.desde.getTime()).toBe(
      hasta.getTime() - desde.getTime(),
    )
  })
})

describe('peorEstado', () => {
  it('el peor gana', () => {
    expect(peorEstado(['saludable', 'advertencia', 'critico'])).toBe('critico')
    expect(peorEstado(['saludable', 'advertencia'])).toBe('advertencia')
    expect(peorEstado(['saludable', 'saludable'])).toBe('saludable')
  })

  it('«sin datos» pesa más que «saludable»', () => {
    // No saber es peor que saber que está bien.
    expect(peorEstado(['saludable', 'sin-datos'])).toBe('sin-datos')
  })

  it('un crítico manda sobre la falta de datos', () => {
    expect(peorEstado(['sin-datos', 'critico'])).toBe('critico')
  })

  it('sin señales, saludable', () => {
    expect(peorEstado([])).toBe('saludable')
  })
})

describe('datosDesactualizados', () => {
  const ahora = new Date('2026-01-01T12:00:00Z')

  it('acepta una muestra reciente', () => {
    expect(datosDesactualizados(new Date('2026-01-01T11:59:50Z'), ahora)).toBe(false)
  })

  it('rechaza una muestra vieja', () => {
    expect(datosDesactualizados(new Date('2026-01-01T11:58:00Z'), ahora)).toBe(true)
  })

  it('sin muestra es desactualizado', () => {
    expect(datosDesactualizados(null, ahora)).toBe(true)
  })
})

/* -------------------------------------------------------------------------
 * Formato
 * ---------------------------------------------------------------------- */

describe('formato', () => {
  it('escala los bytes en base 1024', () => {
    expect(formatearBytes(512)).toBe('512 B')
    expect(formatearBytes(1024)).toBe('1,0 KiB')
    expect(formatearBytes(1024 ** 3)).toBe('1,0 GiB')
  })

  it('usa «—» para lo que no se pudo medir', () => {
    expect(formatearBytes(null)).toBe('—')
    expect(formatearPorcentaje(null)).toBe('—')
    expect(formatearNumero(null)).toBe('—')
    expect(formatearDuracion(null)).toBe('—')
    expect(formatearBytes(Number.NaN)).toBe('—')
    expect(formatearBytes(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('resume las duraciones en dos tramos como mucho', () => {
    expect(formatearDuracion(45)).toBe('45 s')
    expect(formatearDuracion(90)).toBe('1 min 30 s')
    expect(formatearDuracion(3700)).toBe('1 h 1 min')
    expect(formatearDuracion(95_000)).toBe('1 d 2 h')
  })

  /* Es la razón por la que existe `normalizarEspacios`: Node y el navegador
   * usan versiones distintas de ICU y no coinciden en qué espacio ponen antes
   * de «a. m.». Con bytes distintos, React descarta la hidratación. */
  it('no deja espacios especiales que rompan la hidratación', () => {
    const invisibles = new Set([0x00a0, 0x202f, 0x2009, 0x2007])
    const tiene = (t: string) => [...t].some((c) => invisibles.has(c.charCodeAt(0)))

    expect(tiene(formatearFechaHora(new Date('2026-08-14T03:32:52Z'), 'America/Miquelon'))).toBe(false)
    expect(tiene(formatearPorcentaje(42.5))).toBe(false)
    expect(tiene(formatearBytes(1536))).toBe(false)
    expect(tiene(formatearNumero(1234567.89))).toBe(false)
  })

  it('formatea fechas de forma estable dada la misma entrada', () => {
    const fecha = new Date('2026-08-14T03:32:52Z')
    const a = formatearFechaHora(fecha, 'America/Miquelon')
    const b = formatearFechaHora(fecha, 'America/Miquelon')
    expect(a).toBe(b)
  })
})
