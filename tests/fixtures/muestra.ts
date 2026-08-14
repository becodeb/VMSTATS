import type { MuestraHost } from '@vmstats/shared'

/* ============================================================================
 * Muestra de host para los tests.
 *
 * Valores redondos a propósito: 16 GiB de RAM con 8 usados es 50 % exacto, y
 * un test que falla dice «esperaba 50, recibí 43» en vez de comparar dos
 * números feos.
 * ========================================================================== */

const GB = 1024 ** 3

type Parciales = {
  [K in keyof MuestraHost]?: MuestraHost[K] extends object
    ? Partial<MuestraHost[K]>
    : MuestraHost[K]
}

export function muestraDePrueba(cambios: Parciales = {}): MuestraHost {
  const base: MuestraHost = {
    hostId: 'host-de-prueba',
    ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    cpu: {
      total: 35.5,
      user: 22,
      system: 9,
      nice: 0.5,
      idle: 64.5,
      iowait: 2.5,
      irq: 0.5,
      softirq: 1,
      steal: 1.5,
      porNucleo: [40, 35, 30, 37],
    },
    carga: { uno: 2, cinco: 1.8, quince: 1.5, nucleos: 4 },
    memoria: {
      total: 16 * GB,
      usada: 8 * GB,
      disponible: 8 * GB,
      libre: 4 * GB,
      cache: 3 * GB,
      buffers: 1 * GB,
      swapTotal: 2 * GB,
      swapUsada: 0.5 * GB,
    },
    uptimeSegundos: 86_400,
    filesystems: [
      {
        puntoMontaje: '/',
        dispositivo: '/dev/nvme0n1p2',
        tipo: 'ext4',
        tamanio: 100 * GB,
        usado: 50 * GB,
        disponible: 50 * GB,
        inodosTotal: 1_000_000,
        inodosUsados: 100_000,
      },
      {
        puntoMontaje: '/var',
        dispositivo: '/dev/sda1',
        tipo: 'ext4',
        tamanio: 200 * GB,
        usado: 180 * GB,
        disponible: 20 * GB,
        inodosTotal: 2_000_000,
        inodosUsados: 500_000,
      },
    ],
    discos: [
      {
        dispositivo: 'nvme0n1',
        lecturaBytesPorSeg: 1024 * 1024,
        escrituraBytesPorSeg: 2 * 1024 * 1024,
        lecturaOpsPorSeg: 100,
        escrituraOpsPorSeg: 200,
        utilizacion: 15,
        latenciaLecturaMs: 0.5,
        latenciaEscrituraMs: 1.2,
      },
    ],
    red: [
      {
        interfaz: 'eth0',
        rxBytesPorSeg: 1024 * 1024,
        txBytesPorSeg: 512 * 1024,
        rxPaquetesPorSeg: 1000,
        txPaquetesPorSeg: 800,
        rxErrores: 0,
        txErrores: 0,
        rxDescartes: 0,
        txDescartes: 0,
      },
    ],
    tcp: { establecidas: 42, escuchando: 12, timeWait: 8, total: 62 },
    procesos: [
      { pid: 1, comando: 'systemd', usuario: 'root', cpuPorcentaje: 0.1, memoriaBytes: 10 * 1024 * 1024 },
    ],
    presion: {
      cpu: { some10: 5, some60: 4, some300: 3, full10: null, full60: null, full300: null },
      memoria: { some10: 1, some60: 1, some300: 1, full10: 0, full60: 0, full300: 0 },
      io: { some10: 8, some60: 6, some300: 4, full10: 0, full60: 0, full300: 0 },
    },
    temperaturas: [],
    sistema: {
      hostname: 'prueba',
      kernel: '6.1.0-test',
      distribucion: 'Debian GNU/Linux 12 (bookworm)',
      arquitectura: 'x86_64',
      nucleos: 4,
    },
    capacidades: {
      presion: true,
      temperatura: false,
      ioDisco: true,
      latenciaIo: true,
      procesos: true,
      contenedores: false,
      coolify: false,
    },
  }

  // Mezcla superficial por sección: alcanza para los tests y evita traer una
  // librería de deep-merge para cinco casos.
  const resultado = { ...base } as MuestraHost
  for (const [clave, valor] of Object.entries(cambios)) {
    const actual = base[clave as keyof MuestraHost]
    if (
      typeof valor === 'object' &&
      valor !== null &&
      !Array.isArray(valor) &&
      typeof actual === 'object' &&
      actual !== null &&
      !Array.isArray(actual)
    ) {
      Object.assign(resultado, { [clave]: { ...actual, ...valor } })
    } else {
      Object.assign(resultado, { [clave]: valor })
    }
  }

  return resultado
}
