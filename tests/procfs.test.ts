import { describe, expect, it } from 'vitest'
import {
  BYTES_POR_SECTOR,
  esDispositivoReal,
  esFilesystemDeSoloLectura,
  esFilesystemReportable,
  esInterfazReportable,
  parsearDiskstats,
  parsearLoadavg,
  parsearMeminfo,
  parsearMounts,
  parsearNetDev,
  parsearOsRelease,
  parsearPresion,
  parsearStat,
  parsearStatProceso,
  parsearTcp,
  parsearTemperatura,
  parsearUidProceso,
  parsearUptime,
} from '../apps/collector/src/procfs/parsers.js'
import {
  delta,
  derivarCpu,
  derivarCpuCompleto,
  derivarCpuProceso,
  derivarDiscos,
  derivarRed,
  tasa,
} from '../apps/collector/src/procfs/derivar.js'
import * as fixture from './fixtures/procfs.js'

/* ============================================================================
 * Parsers de /proc.
 *
 * Todo contra contenidos capturados de un host Linux real. Es la única parte
 * del collector que se puede testear sin Linux, y es también donde están los
 * errores más caros: un índice corrido en /proc/[pid]/stat no rompe nada, sólo
 * muestra el número equivocado para siempre.
 * ========================================================================== */

describe('parsearStat', () => {
  it('separa el total de los núcleos', () => {
    const estado = parsearStat(fixture.STAT)
    expect(estado.porNucleo).toHaveLength(4)
    expect(estado.total.user).toBe(1234567)
    expect(estado.total.iowait).toBe(12345)
    expect(estado.total.steal).toBe(1011)
    expect(estado.cambiosContexto).toBe(987654321)
    expect(estado.procesosCorriendo).toBe(2)
  })

  it('trata como cero las columnas que un kernel viejo no publica', () => {
    const estado = parsearStat('cpu  100 200 300 400\ncpu0 100 200 300 400\n')
    expect(estado.total.idle).toBe(400)
    expect(estado.total.steal).toBe(0)
    expect(estado.total.iowait).toBe(0)
  })

  it('sobrevive a un archivo vacío', () => {
    const estado = parsearStat('')
    expect(estado.porNucleo).toHaveLength(0)
    expect(estado.total.user).toBe(0)
  })
})

describe('parsearMeminfo', () => {
  it('convierte kB a bytes', () => {
    const memoria = parsearMeminfo(fixture.MEMINFO)
    expect(memoria.total).toBe(16_305_892 * 1024)
    expect(memoria.disponible).toBe(9_876_543 * 1024)
  })

  it('suma SReclaimable a la cache', () => {
    const memoria = parsearMeminfo(fixture.MEMINFO)
    expect(memoria.cache).toBe((6_543_210 + 345_678) * 1024)
  })

  it('aproxima MemAvailable cuando el kernel no lo publica', () => {
    const memoria = parsearMeminfo(fixture.MEMINFO_SIN_AVAILABLE)
    // libre + buffers + cache, que es la fórmula clásica anterior a 3.14.
    expect(memoria.disponible).toBe((1_234_567 + 234_567 + 6_543_210 + 345_678) * 1024)
  })
})

describe('parsearLoadavg y parsearUptime', () => {
  it('lee los tres promedios', () => {
    expect(parsearLoadavg(fixture.LOADAVG)).toEqual({ uno: 0.52, cinco: 0.58, quince: 0.59 })
  })

  it('lee los segundos desde el arranque', () => {
    expect(parsearUptime(fixture.UPTIME)).toBeCloseTo(1_284_300.45, 2)
  })
})

describe('parsearDiskstats', () => {
  it('descarta particiones y dispositivos virtuales', () => {
    const discos = parsearDiskstats(fixture.DISKSTATS)
    const nombres = discos.map((d) => d.dispositivo)
    expect(nombres).toEqual(['nvme0n1', 'sda'])
    expect(nombres).not.toContain('loop0')
    expect(nombres).not.toContain('nvme0n1p1')
    expect(nombres).not.toContain('sda1')
  })

  it('lee las columnas en el orden correcto', () => {
    const nvme = parsearDiskstats(fixture.DISKSTATS).find((d) => d.dispositivo === 'nvme0n1')
    expect(nvme?.lecturas).toBe(123456)
    expect(nvme?.sectoresLeidos).toBe(9876543)
    expect(nvme?.escrituras).toBe(234567)
    expect(nvme?.sectoresEscritos).toBe(8765432)
    expect(nvme?.msEnIo).toBe(34567)
  })

  it('reconoce los nombres de dispositivo por familia', () => {
    expect(esDispositivoReal('sda')).toBe(true)
    expect(esDispositivoReal('nvme0n1')).toBe(true)
    expect(esDispositivoReal('vda')).toBe(true)
    expect(esDispositivoReal('sda1')).toBe(false)
    expect(esDispositivoReal('nvme0n1p2')).toBe(false)
    expect(esDispositivoReal('loop3')).toBe(false)
    expect(esDispositivoReal('dm-0')).toBe(false)
  })
})

describe('parsearNetDev', () => {
  it('descarta loopback y conserva las interfaces de Docker', () => {
    const interfaces = parsearNetDev(fixture.NET_DEV).map((i) => i.interfaz)
    expect(interfaces).toEqual(['eth0', 'docker0'])
    expect(esInterfazReportable('lo')).toBe(false)
    expect(esInterfazReportable('docker0')).toBe(true)
  })

  it('no confunde las columnas de recepción con las de envío', () => {
    const eth0 = parsearNetDev(fixture.NET_DEV).find((i) => i.interfaz === 'eth0')
    expect(eth0?.rxBytes).toBe(1234567890)
    expect(eth0?.txBytes).toBe(987654321)
    expect(eth0?.rxErrores).toBe(12)
    expect(eth0?.txErrores).toBe(3)
    expect(eth0?.rxDescartes).toBe(5)
  })
})

describe('parsearPresion', () => {
  it('lee some y full', () => {
    const presion = parsearPresion(fixture.PRESSURE_CPU)
    expect(presion.some).toEqual({ avg10: 1.23, avg60: 2.34, avg300: 3.45 })
    expect(presion.full).not.toBeNull()
  })

  it('deja full en null cuando el kernel no lo publica', () => {
    const presion = parsearPresion(fixture.PRESSURE_CPU_SIN_FULL)
    expect(presion.some?.avg10).toBe(1.23)
    expect(presion.full).toBeNull()
  })
})

describe('parsearTcp', () => {
  it('cuenta por estado sumando IPv4 e IPv6', () => {
    const conteo = parsearTcp([fixture.NET_TCP, fixture.NET_TCP6])
    expect(conteo.establecidas).toBe(2)
    expect(conteo.escuchando).toBe(2)
    expect(conteo.timeWait).toBe(1)
    expect(conteo.total).toBe(5)
  })

  it('ignora la fila de encabezado', () => {
    expect(parsearTcp(['  sl  local_address rem_address   st\n']).total).toBe(0)
  })
})

describe('parsearMounts', () => {
  it('desescapa los espacios en octal', () => {
    const puntos = parsearMounts(fixture.MOUNTS).map((m) => m.puntoMontaje)
    expect(puntos).toContain('/mnt/disco externo')
  })

  it('filtra pseudo-filesystems y montajes internos de Docker', () => {
    const reportables = parsearMounts(fixture.MOUNTS)
      .filter(esFilesystemReportable)
      .map((m) => m.puntoMontaje)

    expect(reportables).toContain('/')
    expect(reportables).toContain('/boot/efi')
    expect(reportables).toContain('/mnt/disco externo')
    expect(reportables).toContain('/run')
    expect(reportables).toContain('/dev/shm')

    expect(reportables).not.toContain('/proc')
    expect(reportables).not.toContain('/sys')
    expect(reportables).not.toContain('/sys/fs/cgroup')
    expect(reportables).not.toContain('/tmp')
    expect(reportables.some((p) => p.startsWith('/var/lib/docker/'))).toBe(false)
  })
})

describe('parsearStatProceso', () => {
  it('lee un nombre simple', () => {
    const proceso = parsearStatProceso(fixture.PID_STAT_SIMPLE)
    expect(proceso?.pid).toBe(1234)
    expect(proceso?.comando).toBe('postgres')
    expect(proceso?.jiffies).toBe(456 + 789)
    expect(proceso?.arranque).toBe(987654)
    expect(proceso?.rssPaginas).toBe(45678)
  })

  it('lee un nombre con espacios sin correr las columnas', () => {
    const proceso = parsearStatProceso(fixture.PID_STAT_CON_ESPACIOS)
    expect(proceso?.comando).toBe('Web Content')
    expect(proceso?.jiffies).toBe(1234 + 567)
    expect(proceso?.rssPaginas).toBe(123456)
  })

  it('lee un nombre con paréntesis adentro', () => {
    // Se busca el ÚLTIMO `)`: cortar en el primero deja el nombre a medias y
    // corre todos los índices siguientes.
    const proceso = parsearStatProceso(fixture.PID_STAT_CON_PARENTESIS)
    expect(proceso?.comando).toBe('raro(nombre)aca')
    expect(proceso?.jiffies).toBe(30)
    expect(proceso?.rssPaginas).toBe(999)
  })

  it('devuelve null ante basura', () => {
    expect(parsearStatProceso('esto no es un stat')).toBeNull()
    expect(parsearStatProceso('')).toBeNull()
  })
})

describe('parsearUidProceso', () => {
  it('toma el uid real, que es el primero de los cuatro', () => {
    expect(parsearUidProceso(fixture.PID_STATUS)).toBe(113)
  })

  it('devuelve null si no está la línea', () => {
    expect(parsearUidProceso('Name:\tcosa\n')).toBeNull()
  })
})

describe('identidad del sistema', () => {
  it('saca PRETTY_NAME sin comillas', () => {
    expect(parsearOsRelease(fixture.OS_RELEASE)).toBe('Debian GNU/Linux 12 (bookworm)')
  })

  it('convierte milésimas de grado a celsius', () => {
    expect(parsearTemperatura('45000\n')).toBe(45)
  })

  it('descarta lecturas absurdas de un sensor desconectado', () => {
    expect(parsearTemperatura('8000000\n')).toBeNull()
    expect(parsearTemperatura('-100000\n')).toBeNull()
    expect(parsearTemperatura('basura')).toBeNull()
  })
})

/* -------------------------------------------------------------------------
 * Derivadas
 * ---------------------------------------------------------------------- */

describe('delta y tasa', () => {
  it('resta contadores monótonos', () => {
    expect(delta(150, 100)).toBe(50)
    expect(tasa(150, 100, 10)).toBe(5)
  })

  it('devuelve cero si el contador se reinició', () => {
    // Reboot, interfaz recreada o wrap de 32 bits: el valor nuevo NO es el
    // delta. Reportarlo como tal produce un pico gigante y falso.
    expect(delta(10, 1000)).toBe(0)
    expect(tasa(10, 1000, 10)).toBe(0)
  })

  it('no divide por cero', () => {
    expect(tasa(150, 100, 0)).toBe(0)
  })
})

describe('derivarCpu', () => {
  it('calcula porcentajes que suman el intervalo', () => {
    const antes = parsearStat(fixture.STAT).total
    const despues = parsearStat(fixture.STAT_DESPUES).total
    const cpu = derivarCpu(despues, antes)

    expect(cpu.total).toBeGreaterThan(0)
    expect(cpu.total).toBeLessThanOrEqual(100)
    expect(cpu.total).toBeCloseTo(100 - cpu.idle, 6)

    const suma =
      cpu.user + cpu.nice + cpu.system + cpu.idle + cpu.iowait + cpu.irq + cpu.softirq + cpu.steal
    expect(suma).toBeCloseTo(100, 6)
  })

  it('devuelve el sistema ocioso si no pasó tiempo', () => {
    const t = parsearStat(fixture.STAT).total
    const cpu = derivarCpu(t, t)
    expect(cpu.total).toBe(0)
    expect(cpu.idle).toBe(100)
  })

  it('da un valor por núcleo', () => {
    const cpu = derivarCpuCompleto(
      parsearStat(fixture.STAT_DESPUES),
      parsearStat(fixture.STAT),
    )
    expect(cpu.porNucleo).toHaveLength(4)
    for (const valor of cpu.porNucleo) {
      expect(valor).toBeGreaterThanOrEqual(0)
      expect(valor).toBeLessThanOrEqual(100)
    }
  })

  it('reporta cero para un núcleo que apareció por hotplug', () => {
    const previo = parsearStat('cpu 100 0 100 1000\ncpu0 100 0 100 1000\n')
    const actual = parsearStat(
      'cpu 200 0 200 2000\ncpu0 200 0 200 2000\ncpu1 50 0 50 500\n',
    )
    expect(derivarCpuCompleto(actual, previo).porNucleo[1]).toBe(0)
  })
})

describe('derivarDiscos', () => {
  const discos = derivarDiscos(
    parsearDiskstats(fixture.DISKSTATS_DESPUES),
    parsearDiskstats(fixture.DISKSTATS),
    10,
  )

  it('convierte sectores a bytes por segundo', () => {
    const nvme = discos.find((d) => d.dispositivo === 'nvme0n1')
    // 9896543 - 9876543 = 20000 sectores en 10 s.
    expect(nvme?.lecturaBytesPorSeg).toBe((20_000 / 10) * BYTES_POR_SECTOR)
  })

  it('deja la latencia en null cuando no hubo operaciones', () => {
    // `sda` no cambió entre las dos lecturas: sin operaciones no hay latencia
    // que promediar, y un 0 diría «respondió al instante».
    const sda = discos.find((d) => d.dispositivo === 'sda')
    expect(sda?.latenciaLecturaMs).toBeNull()
    expect(sda?.escrituraBytesPorSeg).toBe(0)
  })

  it('omite dispositivos sin lectura previa', () => {
    expect(derivarDiscos(parsearDiskstats(fixture.DISKSTATS), [], 10)).toHaveLength(0)
  })

  it('recorta la utilización a 100', () => {
    for (const disco of discos) {
      expect(disco.utilizacion ?? 0).toBeLessThanOrEqual(100)
    }
  })
})

describe('derivarRed', () => {
  const interfaces = derivarRed(
    parsearNetDev(fixture.NET_DEV_DESPUES),
    parsearNetDev(fixture.NET_DEV),
    10,
  )

  it('calcula bytes por segundo', () => {
    const eth0 = interfaces.find((i) => i.interfaz === 'eth0')
    // 1234577890 - 1234567890 = 10000 bytes en 10 s.
    expect(eth0?.rxBytesPorSeg).toBe(1000)
  })

  it('reporta errores como delta del intervalo, no como acumulado', () => {
    const eth0 = interfaces.find((i) => i.interfaz === 'eth0')
    expect(eth0?.rxErrores).toBe(2)
    expect(eth0?.txErrores).toBe(0)
  })
})

describe('derivarCpuProceso', () => {
  it('convierte jiffies a porcentaje de un núcleo', () => {
    // 100 jiffies en 1 segundo, con USER_HZ 100, es un núcleo al 100 %.
    expect(derivarCpuProceso(100, 0, 1)).toBeCloseTo(100, 6)
  })

  it('puede pasar de 100 en un proceso multihilo', () => {
    expect(derivarCpuProceso(400, 0, 1)).toBeCloseTo(400, 6)
  })
})

/* -------------------------------------------------------------------------
 * Interfaces virtuales
 *
 * Docker crea un par `veth` por contenedor. En un host con cuarenta
 * contenedores, listarlas entierra las interfaces reales; su tráfico ya
 * aparece agregado en `docker0`.
 * ---------------------------------------------------------------------- */

describe('esInterfazReportable', () => {
  it('conserva las interfaces reales y el bridge de Docker', () => {
    expect(esInterfazReportable('eth0')).toBe(true)
    expect(esInterfazReportable('ens3')).toBe(true)
    expect(esInterfazReportable('docker0')).toBe(true)
    expect(esInterfazReportable('wg0')).toBe(true)
  })

  it('descarta loopback y los pares virtuales de contenedor', () => {
    expect(esInterfazReportable('lo')).toBe(false)
    expect(esInterfazReportable('veth847d823')).toBe(false)
    expect(esInterfazReportable('vethf0efd8f')).toBe(false)
    expect(esInterfazReportable('br-a1b2c3d4e5f6')).toBe(false)
  })
})

/* -------------------------------------------------------------------------
 * Filesystems que están llenos por diseño
 *
 * Una imagen `squashfs` de un snap o un `iso9660` montado están comprimidos y
 * sellados: no tienen espacio libre nunca. Listarlos dispara una alerta
 * crítica permanente que nadie puede resolver, y a la semana el operador
 * ignora todas las alertas de disco.
 * ---------------------------------------------------------------------- */

describe('filesystems de sólo lectura', () => {
  it('reconoce los tipos que están siempre al 100 %', () => {
    expect(esFilesystemDeSoloLectura('squashfs')).toBe(true)
    expect(esFilesystemDeSoloLectura('iso9660')).toBe(true)
    expect(esFilesystemDeSoloLectura('erofs')).toBe(true)
    expect(esFilesystemDeSoloLectura('ext4')).toBe(false)
    expect(esFilesystemDeSoloLectura('xfs')).toBe(false)
  })

  it('los excluye de la lista de filesystems', () => {
    const montajes = parsearMounts(
      '/dev/loop0 /snap/core22/1 squashfs ro,nodev,relatime 0 0\n' +
        '/dev/sr0 /media/cdrom iso9660 ro,relatime 0 0\n' +
        '/dev/sda1 / ext4 rw,relatime 0 0\n',
    ).filter(esFilesystemReportable)

    expect(montajes.map((m) => m.puntoMontaje)).toEqual(['/'])
  })
})
