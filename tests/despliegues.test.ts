import { describe, expect, it } from 'vitest'
import type { Despliegue, EstadoDespliegue } from '@vmstats/shared'
import {
  normalizarAplicacion,
  normalizarDespliegue,
  normalizarEstadoDespliegue,
} from '../apps/collector/src/coolify/cliente.js'
import {
  RITMO_POR_DEFECTO,
  diferenciarDespliegues,
  proximoIntervalo,
  resolverDesaparecido,
} from '../apps/collector/src/coolify/seguimiento.js'
import {
  calcularCpuContenedor,
  calcularLimiteMemoria,
  calcularMemoriaContenedor,
  identidadCoolify,
  nombreContenedor,
  normalizarEstado,
  normalizarPuertos,
  saludDesdeStatus,
  sumarBlkio,
  sumarRed,
} from '../apps/collector/src/docker/normalizar.js'

/* ============================================================================
 * Seguimiento de despliegues y normalización de Docker.
 * ========================================================================== */

function despliegue(uuid: string, estado: EstadoDespliegue): Despliegue {
  return {
    uuid,
    aplicacionUuid: 'app-1',
    aplicacionNombre: 'tienda',
    estado,
    rama: 'main',
    commit: 'abc1234567',
    commitMensaje: 'un cambio',
    iniciadoEn: new Date('2026-01-01T10:00:00Z').toISOString(),
    finalizadoEn: null,
    duracionSegundos: null,
    url: null,
  }
}

describe('normalizarEstadoDespliegue', () => {
  it('mapea los estados conocidos', () => {
    expect(normalizarEstadoDespliegue('queued')).toBe('queued')
    expect(normalizarEstadoDespliegue('in_progress')).toBe('in_progress')
    expect(normalizarEstadoDespliegue('finished')).toBe('finished')
    expect(normalizarEstadoDespliegue('failed')).toBe('failed')
  })

  it('acepta las variantes de cancelado entre versiones de Coolify', () => {
    expect(normalizarEstadoDespliegue('cancelled-by-user')).toBe('cancelled')
    expect(normalizarEstadoDespliegue('canceled')).toBe('cancelled')
  })

  it('cae en desconocido en vez de romper', () => {
    expect(normalizarEstadoDespliegue('algo_nuevo_de_coolify')).toBe('unknown')
    expect(normalizarEstadoDespliegue(null)).toBe('unknown')
    expect(normalizarEstadoDespliegue(undefined)).toBe('unknown')
  })
})

describe('normalizarDespliegue', () => {
  const ramas = new Map([['7', 'produccion']])

  it('completa la rama desde la aplicación', () => {
    const d = normalizarDespliegue(
      { deployment_uuid: 'u1', application_id: 7, status: 'in_progress' },
      ramas,
    )
    expect(d.rama).toBe('produccion')
    expect(d.aplicacionUuid).toBe('7')
  })

  it('no inventa un fin para un despliegue en curso', () => {
    const d = normalizarDespliegue(
      {
        deployment_uuid: 'u1',
        status: 'in_progress',
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:05:00Z',
      },
      ramas,
    )
    // `updated_at` cambia con cada latido: tomarlo como fin daría una duración
    // que crece sola mientras el deploy sigue corriendo.
    expect(d.finalizadoEn).toBeNull()
    expect(d.duracionSegundos).toBeNull()
  })

  it('calcula la duración de uno terminado', () => {
    const d = normalizarDespliegue(
      {
        deployment_uuid: 'u1',
        status: 'finished',
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:05:00Z',
      },
      ramas,
    )
    expect(d.duracionSegundos).toBe(300)
  })

  it('descarta una URL que no es http', () => {
    const d = normalizarDespliegue(
      { deployment_uuid: 'u1', status: 'finished', deployment_url: 'javascript:alert(1)' },
      ramas,
    )
    expect(d.url).toBeNull()
  })

  it('conserva una URL válida', () => {
    const d = normalizarDespliegue(
      { deployment_uuid: 'u1', status: 'finished', deployment_url: 'https://coolify.local/d/1' },
      ramas,
    )
    expect(d.url).toBe('https://coolify.local/d/1')
  })
})

describe('diferenciarDespliegues', () => {
  it('registra un despliegue nuevo', () => {
    const r = diferenciarDespliegues([despliegue('u1', 'queued')], new Map())
    expect(r.transiciones).toHaveLength(1)
    expect(r.transiciones[0]?.estadoAnterior).toBeNull()
    expect(r.conocidos.get('u1')).toBe('queued')
  })

  it('no repite un estado que no cambió', () => {
    const conocidos = new Map<string, EstadoDespliegue>([['u1', 'in_progress']])
    const r = diferenciarDespliegues([despliegue('u1', 'in_progress')], conocidos)
    expect(r.transiciones).toHaveLength(0)
  })

  it('registra el cambio de estado', () => {
    const conocidos = new Map<string, EstadoDespliegue>([['u1', 'queued']])
    const r = diferenciarDespliegues([despliegue('u1', 'in_progress')], conocidos)
    expect(r.transiciones).toHaveLength(1)
    expect(r.transiciones[0]?.estadoAnterior).toBe('queued')
  })

  it('marca para consultar el que desapareció estando activo', () => {
    // `/deployments` sólo lista los que corren: si desapareció, terminó, y hay
    // que ir a buscar con qué estado.
    const conocidos = new Map<string, EstadoDespliegue>([['u1', 'in_progress']])
    const r = diferenciarDespliegues([], conocidos)
    expect(r.aConsultar).toEqual(['u1'])
  })

  it('olvida el que desapareció ya terminado', () => {
    const conocidos = new Map<string, EstadoDespliegue>([['u1', 'finished']])
    const r = diferenciarDespliegues([], conocidos)
    expect(r.aConsultar).toEqual([])
    expect(r.conocidos.has('u1')).toBe(false)
  })

  it('no muta el mapa que recibe', () => {
    // El llamador adopta el mapa nuevo recién después de persistir: si se
    // mutara acá, un fallo de base haría perder la transición.
    const conocidos = new Map<string, EstadoDespliegue>([['u1', 'queued']])
    diferenciarDespliegues([despliegue('u1', 'in_progress')], conocidos)
    expect(conocidos.get('u1')).toBe('queued')
  })
})

describe('resolverDesaparecido', () => {
  it('usa el estado real si Coolify todavía lo conoce', () => {
    const t = resolverDesaparecido('u1', despliegue('u1', 'failed'), 'in_progress')
    expect(t.despliegue.estado).toBe('failed')
    expect(t.estadoAnterior).toBe('in_progress')
  })

  it('lo cierra como desconocido si Coolify ya lo purgó', () => {
    // Dejarlo «en curso» para siempre sería peor: la UI mostraría un deploy
    // eterno de hace tres días.
    const t = resolverDesaparecido('u1', null, 'in_progress')
    expect(t.despliegue.estado).toBe('unknown')
    expect(t.despliegue.finalizadoEn).not.toBeNull()
  })
})

describe('proximoIntervalo', () => {
  it('acelera cuando hay algo desplegándose', () => {
    expect(proximoIntervalo(true, 0)).toBe(RITMO_POR_DEFECTO.intervaloActivoMs)
  })

  it('afloja cuando no hay nada', () => {
    expect(proximoIntervalo(false, 0)).toBe(RITMO_POR_DEFECTO.intervaloOciosoMs)
  })

  it('duplica el intervalo con cada error', () => {
    const uno = proximoIntervalo(true, 1)
    const dos = proximoIntervalo(true, 2)
    const tres = proximoIntervalo(true, 3)
    expect(dos).toBe(uno * 2)
    expect(tres).toBe(uno * 4)
  })

  it('tiene techo', () => {
    expect(proximoIntervalo(true, 50)).toBe(RITMO_POR_DEFECTO.intervaloMaximoMs)
  })
})

describe('normalizarAplicacion', () => {
  it('cae al uuid si no hay nombre', () => {
    expect(normalizarAplicacion({ uuid: 'abc' }).nombre).toBe('abc')
  })
})

/* -------------------------------------------------------------------------
 * Docker
 * ---------------------------------------------------------------------- */

describe('calcularCpuContenedor', () => {
  it('escala por la cantidad de núcleos', () => {
    // 25 % del delta del sistema con 4 núcleos = 100 %.
    const cpu = calcularCpuContenedor(
      { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 4000, online_cpus: 4 },
      { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: 4 },
      10,
    )
    expect(cpu).toBeCloseTo(100, 6)
  })

  it('funciona sin system_cpu_usage, como en cgroup v2', () => {
    // 1e9 nanosegundos de CPU en 1 segundo = un núcleo al 100 %.
    const cpu = calcularCpuContenedor(
      { cpu_usage: { total_usage: 1e9 } },
      { cpu_usage: { total_usage: 0 } },
      1,
    )
    expect(cpu).toBeCloseTo(100, 6)
  })

  it('devuelve cero en la primera muestra', () => {
    expect(calcularCpuContenedor({ cpu_usage: { total_usage: 1000 } }, null, 10)).toBe(0)
  })
})

describe('memoria del contenedor', () => {
  it('descuenta la cache reclamable', () => {
    // Sin esto, un contenedor que leyó un archivo grande parece al límite.
    const usada = calcularMemoriaContenedor({
      usage: 1000,
      stats: { inactive_file: 400 },
    })
    expect(usada).toBe(600)
  })

  it('acepta el nombre de cgroup v1', () => {
    expect(
      calcularMemoriaContenedor({ usage: 1000, stats: { total_inactive_file: 250 } }),
    ).toBe(750)
  })

  it('detecta que no hay límite real', () => {
    // Sin límite, Docker informa la RAM del host: dibujar una barra contra eso
    // sería un tope que no existe.
    const host = 16 * 1024 ** 3
    expect(calcularLimiteMemoria({ limit: host }, host)).toBeNull()
    expect(calcularLimiteMemoria({ limit: 2 * 1024 ** 3 }, host)).toBe(2 * 1024 ** 3)
  })
})

describe('saludDesdeStatus', () => {
  it('saca la salud del texto de estado', () => {
    expect(saludDesdeStatus('Up 2 hours (healthy)')).toBe('healthy')
    expect(saludDesdeStatus('Up 5 minutes (unhealthy)')).toBe('unhealthy')
    expect(saludDesdeStatus('Up 3 seconds (health: starting)')).toBe('starting')
  })

  it('devuelve «none» cuando la imagen no declara healthcheck', () => {
    // Distinto de sano: nadie comprobó nada.
    expect(saludDesdeStatus('Up 2 hours')).toBe('none')
    expect(saludDesdeStatus('Exited (0) 3 minutes ago')).toBe('none')
  })
})

describe('normalizarEstado y nombre', () => {
  it('acepta los estados de Docker', () => {
    expect(normalizarEstado('running')).toBe('running')
    expect(normalizarEstado('RESTARTING')).toBe('restarting')
  })

  it('cae en «dead» ante un estado desconocido', () => {
    expect(normalizarEstado('inventado')).toBe('dead')
  })

  it('saca la barra inicial del nombre', () => {
    expect(nombreContenedor(['/vmstats-web'])).toBe('vmstats-web')
    expect(nombreContenedor([])).toBe('(sin nombre)')
  })
})

describe('sumas de red y bloque', () => {
  it('suma todas las redes del contenedor', () => {
    const total = sumarRed({
      eth0: { rx_bytes: 100, tx_bytes: 200 },
      eth1: { rx_bytes: 50, tx_bytes: 25 },
    })
    expect(total).toEqual({ rx: 150, tx: 225 })
  })

  it('devuelve cero sin datos de red', () => {
    expect(sumarRed(undefined)).toEqual({ rx: 0, tx: 0 })
  })

  it('separa lectura de escritura en blkio', () => {
    const io = sumarBlkio({
      io_service_bytes_recursive: [
        { op: 'Read', value: 100 },
        { op: 'Write', value: 200 },
        { op: 'Sync', value: 300 },
      ],
    })
    expect(io).toEqual({ lectura: 100, escritura: 200 })
  })

  it('tolera blkio nulo, que es lo que devuelve cgroup v2 a veces', () => {
    expect(sumarBlkio({ io_service_bytes_recursive: null })).toEqual({
      lectura: 0,
      escritura: 0,
    })
  })
})

describe('identidadCoolify', () => {
  it('reconoce las labels de Coolify', () => {
    const id = identidadCoolify({
      'coolify.applicationId': 'uuid-1',
      'coolify.name': 'tienda',
    })
    expect(id).toEqual({ aplicacion: 'tienda', uuid: 'uuid-1' })
  })

  it('cae al proyecto de compose si Coolify lo administra', () => {
    const id = identidadCoolify({
      'coolify.managed': 'true',
      'com.docker.compose.project': 'mi-proyecto',
    })
    expect(id.aplicacion).toBe('mi-proyecto')
  })

  it('deja en null un contenedor levantado a mano', () => {
    // No es un error: aparece en la lista igual, sin aplicación asociada.
    expect(identidadCoolify({})).toEqual({ aplicacion: null, uuid: null })
    expect(identidadCoolify({ 'com.docker.compose.project': 'ajeno' }).aplicacion).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Respuestas incompletas de Docker
 *
 * La API devuelve `null` —no colecciones vacías— en varios campos. Con los
 * tipos optimistas, el collector se caía en cada ciclo contra un Docker real.
 * ---------------------------------------------------------------------- */

describe('campos nulos de la API de Docker', () => {
  it('acepta Ports en null', () => {
    expect(normalizarPuertos(null)).toEqual([])
    expect(normalizarPuertos(undefined)).toEqual([])
  })

  it('acepta Names en null', () => {
    expect(nombreContenedor(null)).toBe('(sin nombre)')
  })

  it('acepta Labels en null', () => {
    expect(identidadCoolify(null)).toEqual({ aplicacion: null, uuid: null })
  })
})
