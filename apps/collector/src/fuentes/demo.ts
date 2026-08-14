import type { Capacidades, MuestraContenedor, MuestraHost } from '@vmstats/shared'
import type { FuenteContenedores, FuenteHost } from './tipos.js'

/* ============================================================================
 * Fuente sintética, SÓLO para desarrollo.
 *
 * Se activa exclusivamente con `VMSTATS_DEMO=1` y el arranque lo grita en el
 * log. Nunca es el valor por defecto: un panel de infraestructura mostrando
 * números inventados sin avisar es la peor falla posible de este producto.
 *
 * Las series son deterministas dado el reloj, con ciclos de distinta duración
 * para que los gráficos se vean como datos reales y no como una sinusoide.
 * ========================================================================== */

const CAPACIDADES_DEMO: Capacidades = {
  presion: true,
  temperatura: true,
  ioDisco: true,
  latenciaIo: true,
  procesos: true,
  contenedores: true,
  coolify: false,
}

/** Onda suave en [0,1] a partir de varios períodos que no son múltiplos. */
function onda(ms: number, periodoSegundos: number, fase = 0): number {
  return (Math.sin((ms / 1000 / periodoSegundos) * Math.PI * 2 + fase) + 1) / 2
}

function mezcla(ms: number, fase: number): number {
  return (onda(ms, 47, fase) * 0.5 + onda(ms, 173, fase) * 0.3 + onda(ms, 619, fase) * 0.2)
}

const GB = 1024 ** 3

export class FuenteDemo implements FuenteHost {
  readonly #hostId = 'demo-host'
  #primera = true

  capacidades(): Capacidades {
    return { ...CAPACIDADES_DEMO }
  }

  async hostId(): Promise<string> {
    return this.#hostId
  }

  async muestrear(): Promise<MuestraHost | null> {
    // Se respeta el mismo contrato que la fuente real: la primera muestra es
    // la base. Si no, el modo demo escondería bugs del ciclo de arranque.
    if (this.#primera) {
      this.#primera = false
      return null
    }

    const ahora = Date.now()
    const base = mezcla(ahora, 0)
    const cpuTotal = 8 + base * 55
    const idle = 100 - cpuTotal
    const memTotal = 16 * GB
    const memUsada = (0.42 + mezcla(ahora, 1.1) * 0.28) * memTotal

    return {
      hostId: this.#hostId,
      ts: new Date(ahora).toISOString(),
      cpu: {
        total: cpuTotal,
        user: cpuTotal * 0.62,
        system: cpuTotal * 0.22,
        nice: cpuTotal * 0.02,
        idle,
        iowait: cpuTotal * 0.09,
        irq: cpuTotal * 0.02,
        softirq: cpuTotal * 0.03,
        steal: mezcla(ahora, 2.3) * 3,
        porNucleo: Array.from({ length: 4 }, (_, i) => 6 + mezcla(ahora, i + 1) * 70),
      },
      carga: {
        uno: 0.3 + base * 2.4,
        cinco: 0.4 + mezcla(ahora, 0.7) * 1.9,
        quince: 0.5 + mezcla(ahora, 1.9) * 1.3,
        nucleos: 4,
      },
      memoria: {
        total: memTotal,
        usada: memUsada,
        disponible: memTotal - memUsada,
        libre: memTotal - memUsada - 2 * GB,
        cache: 2.6 * GB,
        buffers: 0.4 * GB,
        swapTotal: 2 * GB,
        swapUsada: mezcla(ahora, 3.7) * 0.35 * GB,
      },
      uptimeSegundos: 1_284_300 + ahora / 1000 - 1_760_000_000,
      filesystems: [
        {
          puntoMontaje: '/',
          dispositivo: '/dev/vda1',
          tipo: 'ext4',
          tamanio: 80 * GB,
          usado: (0.54 + mezcla(ahora, 90) * 0.06) * 80 * GB,
          disponible: 32 * GB,
          inodosTotal: 5_242_880,
          inodosUsados: 412_338,
        },
        {
          puntoMontaje: '/var/lib/postgresql',
          dispositivo: '/dev/vdb1',
          tipo: 'ext4',
          tamanio: 200 * GB,
          usado: (0.31 + mezcla(ahora, 120) * 0.04) * 200 * GB,
          disponible: 132 * GB,
          inodosTotal: 13_107_200,
          inodosUsados: 88_291,
        },
      ],
      discos: [
        {
          dispositivo: 'vda',
          lecturaBytesPorSeg: mezcla(ahora, 1.3) * 12 * 1024 * 1024,
          escrituraBytesPorSeg: mezcla(ahora, 2.1) * 28 * 1024 * 1024,
          lecturaOpsPorSeg: mezcla(ahora, 1.3) * 180,
          escrituraOpsPorSeg: mezcla(ahora, 2.1) * 340,
          utilizacion: mezcla(ahora, 1.7) * 45,
          latenciaLecturaMs: 0.4 + mezcla(ahora, 3.1) * 2.2,
          latenciaEscrituraMs: 0.6 + mezcla(ahora, 2.7) * 3.4,
        },
      ],
      red: [
        {
          interfaz: 'eth0',
          rxBytesPorSeg: mezcla(ahora, 0.9) * 4.5 * 1024 * 1024,
          txBytesPorSeg: mezcla(ahora, 1.4) * 2.8 * 1024 * 1024,
          rxPaquetesPorSeg: mezcla(ahora, 0.9) * 3200,
          txPaquetesPorSeg: mezcla(ahora, 1.4) * 2400,
          rxErrores: 0,
          txErrores: 0,
          rxDescartes: 0,
          txDescartes: 0,
        },
      ],
      tcp: {
        establecidas: Math.round(40 + mezcla(ahora, 5) * 120),
        escuchando: 12,
        timeWait: Math.round(8 + mezcla(ahora, 7) * 40),
        total: Math.round(70 + mezcla(ahora, 5) * 160),
      },
      procesos: [
        { pid: 1042, comando: 'postgres', usuario: 'postgres', cpuPorcentaje: 4 + base * 30, memoriaBytes: 1.4 * GB },
        { pid: 2311, comando: 'node', usuario: 'vmstats', cpuPorcentaje: 2 + mezcla(ahora, 1.2) * 18, memoriaBytes: 0.6 * GB },
        { pid: 880, comando: 'dockerd', usuario: 'root', cpuPorcentaje: 1 + mezcla(ahora, 2.4) * 6, memoriaBytes: 0.3 * GB },
      ],
      presion: {
        cpu: { some10: mezcla(ahora, 1.1) * 18, some60: mezcla(ahora, 2.2) * 14, some300: mezcla(ahora, 4.4) * 10, full10: null, full60: null, full300: null },
        memoria: { some10: mezcla(ahora, 1.6) * 4, some60: mezcla(ahora, 3.2) * 3, some300: mezcla(ahora, 6.4) * 2, full10: 0, full60: 0, full300: 0 },
        io: { some10: mezcla(ahora, 1.9) * 22, some60: mezcla(ahora, 3.8) * 16, some300: mezcla(ahora, 7.6) * 11, full10: 0, full60: 0, full300: 0 },
      },
      temperaturas: [{ etiqueta: 'x86_pkg_temp', celsius: 38 + base * 22, criticaCelsius: 100 }],
      sistema: {
        hostname: 'demo',
        kernel: '6.8.0-demo',
        distribucion: 'Debian GNU/Linux 12 (bookworm)',
        arquitectura: 'x86_64',
        nucleos: 4,
      },
      capacidades: this.capacidades(),
    }
  }
}

const NOMBRES_DEMO = [
  { nombre: 'vmstats-web', imagen: 'vmstats/web:0.1.0', app: 'vmstats' },
  { nombre: 'vmstats-collector', imagen: 'vmstats/collector:0.1.0', app: 'vmstats' },
  { nombre: 'vmstats-postgres', imagen: 'postgres:17-alpine', app: 'vmstats' },
  { nombre: 'tienda-web', imagen: 'ghcr.io/acme/tienda:sha-4f21c9a', app: 'tienda' },
  { nombre: 'tienda-worker', imagen: 'ghcr.io/acme/tienda:sha-4f21c9a', app: 'tienda' },
]

export class FuenteContenedoresDemo implements FuenteContenedores {
  disponible(): boolean {
    return true
  }

  async muestrear(): Promise<MuestraContenedor[]> {
    const ahora = Date.now()
    const ts = new Date(ahora).toISOString()

    return NOMBRES_DEMO.map((entrada, i) => ({
      hostId: 'demo-host',
      contenedorId: `demo${String(i).padStart(2, '0')}${'0'.repeat(58)}`,
      ts,
      nombre: entrada.nombre,
      imagen: entrada.imagen,
      // Uno de los cinco se muestra reiniciándose: sirve para ver los estados
      // de error de la UI sin tener que romper algo de verdad.
      estado: i === 4 ? 'restarting' : 'running',
      salud: i === 4 ? 'unhealthy' : i === 2 ? 'healthy' : 'none',
      cpuPorcentaje: mezcla(ahora, 1 + i) * (i === 0 ? 45 : 18),
      memoriaBytes: (0.1 + mezcla(ahora, 2 + i) * 0.5) * GB,
      memoriaLimiteBytes: i === 2 ? 2 * GB : null,
      redRxBytesPorSeg: mezcla(ahora, 1.2 + i) * 900_000,
      redTxBytesPorSeg: mezcla(ahora, 1.8 + i) * 600_000,
      bloqueLecturaBytesPorSeg: mezcla(ahora, 2.5 + i) * 400_000,
      bloqueEscrituraBytesPorSeg: mezcla(ahora, 3.1 + i) * 700_000,
      uptimeSegundos: i === 4 ? 42 : 86_400 * (i + 1),
      reinicios: i === 4 ? 17 : 0,
      puertos: i === 0 ? [{ privado: 4321, publico: 4321, protocolo: 'tcp', ip: '0.0.0.0' }] : [],
      coolifyAplicacion: entrada.app,
      coolifyUuid: `demo-${entrada.app}`,
    }))
  }
}
