import { readFile, readdir, statfs } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type {
  Capacidades,
  Filesystem,
  Memoria,
  MuestraHost,
  Presion,
  Proceso,
  Sistema,
  Tcp,
  Temperatura,
} from '@vmstats/shared'
import {
  esFilesystemReportable,
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
  type EstadoStat,
  type StatsDisco,
  type StatsRed,
  type StatProceso,
} from '../procfs/parsers.js'
import {
  derivarCpuCompleto,
  derivarCpuProceso,
  derivarDiscos,
  derivarRed,
} from '../procfs/derivar.js'
import { CAPACIDADES_VACIAS, type FuenteHost } from './tipos.js'

/* ============================================================================
 * Lectura real de /proc, /sys y statfs.
 *
 * En un contenedor, /proc es el del contenedor, no el del host. Por eso todas
 * las rutas salen de estas variables: el compose monta el /proc del host en
 * /host/proc y acá se lee de ahí. Sin esto, el collector reportaría las
 * métricas de su propio contenedor y todos los números serían mentira.
 * ========================================================================== */

export interface OpcionesProcfs {
  /** Normalmente `/proc`, o `/host/proc` dentro del contenedor. */
  raizProc: string
  /** Normalmente `/sys`, o `/host/sys`. */
  raizSys: string
  /** Prefijo del filesystem del host para `statfs`. Vacío fuera del contenedor. */
  raizFs: string
  /** Cuántos procesos devolver en el top. */
  topProcesos: number
  /** Identidad fija del host, si el operador la definió. Ver `hostId()`. */
  hostIdFijo?: string | undefined
}

export const OPCIONES_PROCFS_POR_DEFECTO: OpcionesProcfs = {
  raizProc: '/proc',
  raizSys: '/sys',
  raizFs: '',
  topProcesos: 10,
}

interface LecturaPrevia {
  en: number
  stat: EstadoStat
  discos: StatsDisco[]
  red: StatsRed[]
  procesos: Map<number, StatProceso>
}

/** Lee un archivo y devuelve null si no existe o no se puede leer. */
async function leerOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, 'utf8')
  } catch {
    return null
  }
}

export class FuenteProcfs implements FuenteHost {
  readonly #opciones: OpcionesProcfs
  #previa: LecturaPrevia | null = null
  #capacidades: Capacidades = { ...CAPACIDADES_VACIAS }
  #usuariosPorUid: Map<number, string> | null = null
  #sistema: Sistema | null = null
  #hostId: string | null = null

  constructor(opciones: Partial<OpcionesProcfs> = {}) {
    this.#opciones = { ...OPCIONES_PROCFS_POR_DEFECTO, ...opciones }
  }

  capacidades(): Capacidades {
    return { ...this.#capacidades }
  }

  #proc(...partes: string[]): string {
    return join(this.#opciones.raizProc, ...partes)
  }

  /**
   * Rutas de /proc que dependen del namespace de quien lee.
   *
   * `/proc/mounts` y todo `/proc/net` son en realidad enlaces a
   * `/proc/self/…`, así que leerlos desde dentro de un contenedor devuelve los
   * montajes y las interfaces DEL CONTENEDOR, aunque se haya montado el /proc
   * del host. Se descubrió al levantar el compose: la consola listaba
   * `/etc/hosts` como filesystem y sólo dos interfaces.
   *
   * La versión del PID 1 sí vive en el namespace raíz del host. Corriendo
   * fuera de un contenedor apunta al mismo lugar, así que no hace falta
   * distinguir los dos casos.
   */
  async #leerDelHost(...partes: string[]): Promise<string | null> {
    const delInit = await leerOpcional(this.#proc('1', ...partes))
    if (delInit !== null) return delInit
    // Con `hidepid` el /proc de PID 1 puede no ser legible: se cae a la ruta
    // normal, que al menos da los datos del contenedor.
    return leerOpcional(this.#proc(...partes))
  }

  /**
   * Identificador estable del host.
   *
   * Es la clave de TODAS las tablas de métricas, así que tiene que sobrevivir a
   * que el contenedor del collector se recree. Si cambia, el historial se parte
   * en dos hosts distintos y la consola muestra una máquina nueva sin pasado.
   *
   * El orden importa y sale de una prueba real: en el primer despliegue el
   * collector estaba usando `/proc/sys/kernel/hostname`, que es relativo al
   * namespace UTS — o sea, el hostname del propio contenedor, distinto en cada
   * arranque.
   *
   *   1. `VMSTATS_HOST_ID`, si el operador lo fijó. Manda siempre.
   *   2. `machine-id` del filesystem del host montado. Sobrevive a reinicios y
   *      a reinstalar vmstats; es lo correcto en una VM normal.
   *   3. `boot_id`, que no depende de ningún namespace. Cambia al reiniciar la
   *      máquina, pero es estable mientras corre.
   *   4. El hostname, como último recurso.
   */
  async hostId(): Promise<string> {
    if (this.#hostId !== null) return this.#hostId

    const fijado = this.#opciones.hostIdFijo?.trim()
    if (fijado !== undefined && fijado.length > 0) {
      this.#hostId = fijado
      return fijado
    }

    const candidatos = [
      join(this.#opciones.raizFs, 'etc', 'machine-id'),
      join(this.#opciones.raizFs, 'var', 'lib', 'dbus', 'machine-id'),
      this.#proc('sys', 'kernel', 'random', 'boot_id'),
    ]
    for (const ruta of candidatos) {
      const contenido = await leerOpcional(ruta)
      const id = contenido?.trim()
      if (id !== undefined && id.length > 0) {
        this.#hostId = id
        return id
      }
    }

    const nombre = (await leerOpcional(this.#proc('sys', 'kernel', 'hostname')))?.trim()
    this.#hostId = nombre !== undefined && nombre.length > 0 ? nombre : hostname()
    return this.#hostId
  }

  async #identidad(): Promise<Sistema> {
    if (this.#sistema !== null) return this.#sistema

    /* El hostname sale del filesystem del host, no de
     * `/proc/sys/kernel/hostname`: ese archivo es relativo al namespace UTS, o
     * sea que dentro de un contenedor devuelve el id del contenedor. La consola
     * terminaba rotulando la máquina con el id efímero del collector. */
    const [kernel, nombreHost, nombreProc, osRelease, arch, stat] = await Promise.all([
      leerOpcional(this.#proc('sys', 'kernel', 'osrelease')),
      leerOpcional(join(this.#opciones.raizFs, 'etc', 'hostname')),
      leerOpcional(this.#proc('sys', 'kernel', 'hostname')),
      leerOpcional(join(this.#opciones.raizFs, 'etc', 'os-release')),
      leerOpcional(this.#proc('sys', 'kernel', 'arch')),
      leerOpcional(this.#proc('stat')),
    ])

    const nombre = (nombreHost?.trim().length ?? 0) > 0 ? nombreHost : nombreProc

    const nucleos = stat === null ? 1 : Math.max(1, parsearStat(stat).porNucleo.length)

    this.#sistema = {
      hostname: nombre?.trim() ?? hostname(),
      kernel: kernel?.trim() ?? 'desconocido',
      distribucion:
        (osRelease === null ? null : parsearOsRelease(osRelease)) ?? 'desconocida',
      arquitectura: arch?.trim() ?? process.arch,
      nucleos,
    }
    return this.#sistema
  }

  /** uid -> nombre, leído una sola vez de /etc/passwd. */
  async #usuarios(): Promise<Map<number, string>> {
    if (this.#usuariosPorUid !== null) return this.#usuariosPorUid

    const mapa = new Map<number, string>()
    const passwd = await leerOpcional(join(this.#opciones.raizFs, 'etc', 'passwd'))
    if (passwd !== null) {
      for (const linea of passwd.split('\n')) {
        const partes = linea.split(':')
        const nombre = partes[0]
        const uid = Number.parseInt(partes[2] ?? '', 10)
        if (nombre !== undefined && Number.isFinite(uid)) mapa.set(uid, nombre)
      }
    }
    this.#usuariosPorUid = mapa
    return mapa
  }

  async #memoria(): Promise<Memoria> {
    const contenido = await leerOpcional(this.#proc('meminfo'))
    if (contenido === null) {
      return {
        total: 0, usada: 0, disponible: 0, libre: 0,
        cache: 0, buffers: 0, swapTotal: 0, swapUsada: 0,
      }
    }
    const m = parsearMeminfo(contenido)
    return {
      total: m.total,
      // "Usada" es total menos disponible, no total menos libre: la cache es
      // reclamable y contarla como ocupada haría ver toda VM sana al 95 %.
      usada: Math.max(0, m.total - m.disponible),
      disponible: m.disponible,
      libre: m.libre,
      cache: m.cache,
      buffers: m.buffers,
      swapTotal: m.swapTotal,
      swapUsada: Math.max(0, m.swapTotal - m.swapLibre),
    }
  }

  async #filesystems(): Promise<Filesystem[]> {
    const contenido = await this.#leerDelHost('mounts')
    if (contenido === null) return []

    const montajes = parsearMounts(contenido).filter(esFilesystemReportable)
    const salida: Filesystem[] = []

    for (const montaje of montajes) {
      // El punto de montaje que reporta /proc/mounts es el del host; dentro
      // del contenedor hay que buscarlo bajo el prefijo montado.
      const ruta = join(this.#opciones.raizFs, montaje.puntoMontaje)
      try {
        const st = await statfs(ruta)
        const tamanio = st.blocks * st.bsize
        // Un filesystem de tamaño cero es un montaje fantasma: no aporta nada
        // y ensucia la lista.
        if (tamanio <= 0) continue

        /* Inodos, si el filesystem los reporta de forma coherente.
         *
         * Varios filesystems —9p y virtiofs de una VM, montajes de red,
         * overlay— devuelven valores de `files`/`ffree` que no cierran: se ven
         * más inodos libres que totales, y la resta da negativo. Se descubrió
         * levantando el compose: un solo montaje así invalidaba la instantánea
         * entera y la consola quedaba en «el collector todavía no reportó».
         *
         * Cuando no cierran, se informan como no disponibles. Un `0` diría que
         * el filesystem no tiene inodos usados, que es falso. */
        const usados = st.files - st.ffree
        const inodosCoherentes = st.files > 0 && usados >= 0 && usados <= st.files

        salida.push({
          puntoMontaje: montaje.puntoMontaje,
          dispositivo: montaje.dispositivo,
          tipo: montaje.tipo,
          tamanio,
          // `bavail` (libre para usuarios comunes) en vez de `bfree`: los
          // bloques reservados para root no están disponibles en la práctica.
          usado: Math.max(0, (st.blocks - st.bfree) * st.bsize),
          disponible: Math.max(0, st.bavail * st.bsize),
          inodosTotal: inodosCoherentes ? st.files : null,
          inodosUsados: inodosCoherentes ? usados : null,
        })
      } catch {
        // Montaje inaccesible desde el contenedor: se omite en vez de fallar.
      }
    }

    return salida
  }

  async #presion(): Promise<Presion> {
    const leerUno = async (nombre: string) => {
      const contenido = await leerOpcional(this.#proc('pressure', nombre))
      if (contenido === null) return null
      const p = parsearPresion(contenido)
      if (p.some === null) return null
      return {
        some10: p.some.avg10,
        some60: p.some.avg60,
        some300: p.some.avg300,
        full10: p.full?.avg10 ?? null,
        full60: p.full?.avg60 ?? null,
        full300: p.full?.avg300 ?? null,
      }
    }

    const [cpu, memoria, io] = await Promise.all([
      leerUno('cpu'),
      leerUno('memory'),
      leerUno('io'),
    ])

    this.#capacidades.presion = cpu !== null || memoria !== null || io !== null
    return { cpu, memoria, io }
  }

  async #tcp(): Promise<Tcp | null> {
    const [v4, v6] = await Promise.all([
      this.#leerDelHost('net', 'tcp'),
      this.#leerDelHost('net', 'tcp6'),
    ])
    const contenidos = [v4, v6].filter((c): c is string => c !== null)
    if (contenidos.length === 0) return null
    return parsearTcp(contenidos)
  }

  /**
   * Temperaturas de /sys/class/thermal.
   *
   * Es una capacidad opcional de verdad: la mayoría de las VMs no expone
   * ningún sensor, y eso no es un error. Si no hay nada, la capacidad queda en
   * false y la UI no dibuja la sección.
   */
  async #temperaturas(): Promise<Temperatura[]> {
    const base = join(this.#opciones.raizSys, 'class', 'thermal')
    let entradas: string[]
    try {
      entradas = await readdir(base)
    } catch {
      this.#capacidades.temperatura = false
      return []
    }

    const salida: Temperatura[] = []
    for (const entrada of entradas) {
      if (!entrada.startsWith('thermal_zone')) continue
      const [temp, tipo] = await Promise.all([
        leerOpcional(join(base, entrada, 'temp')),
        leerOpcional(join(base, entrada, 'type')),
      ])
      if (temp === null) continue
      const celsius = parsearTemperatura(temp)
      if (celsius === null) continue

      salida.push({
        etiqueta: tipo?.trim() ?? entrada,
        criticaCelsius: null,
      celsius,
      })
    }

    this.#capacidades.temperatura = salida.length > 0
    return salida
  }

  /** Snapshot de todos los procesos, indexado por pid. */
  async #leerProcesos(): Promise<Map<number, StatProceso>> {
    const mapa = new Map<number, StatProceso>()
    let entradas: string[]
    try {
      entradas = await readdir(this.#opciones.raizProc)
    } catch {
      return mapa
    }

    // Leemos en tandas: un `Promise.all` sobre mil procesos abre mil handles a
    // la vez y en una VM chica eso compite con lo que estamos midiendo.
    const pids = entradas.filter((e) => /^\d+$/.test(e))
    const TANDA = 64

    for (let i = 0; i < pids.length; i += TANDA) {
      const tanda = pids.slice(i, i + TANDA)
      const resultados = await Promise.all(
        tanda.map(async (pid) => {
          const contenido = await leerOpcional(this.#proc(pid, 'stat'))
          return contenido === null ? null : parsearStatProceso(contenido)
        }),
      )
      for (const proceso of resultados) {
        if (proceso !== null) mapa.set(proceso.pid, proceso)
      }
    }

    return mapa
  }

  /**
   * Top de procesos por CPU y por memoria, unidos.
   *
   * Sólo el nombre del comando, nunca la línea completa: los argumentos
   * filtran tokens y contraseñas con demasiada facilidad
   * (`node server.js --api-key=…`). Ver docs/security.md.
   */
  async #topProcesos(
    actuales: Map<number, StatProceso>,
    previos: Map<number, StatProceso>,
    segundos: number,
    tamanioPagina: number,
  ): Promise<Proceso[]> {
    interface Candidato {
      pid: number
      comando: string
      cpuPorcentaje: number
      memoriaBytes: number
    }

    const candidatos: Candidato[] = []
    for (const [pid, proceso] of actuales) {
      const previo = previos.get(pid)
      // Proceso que arrancó dentro de este intervalo: sin base no hay CPU. Se
      // compara también `arranque` porque el kernel recicla pids: un pid que
      // coincide con otro arranque es otro proceso, no el mismo más viejo.
      const cpu =
        previo === undefined || previo.arranque !== proceso.arranque
          ? 0
          : derivarCpuProceso(proceso.jiffies, previo.jiffies, segundos)

      candidatos.push({
        pid,
        comando: proceso.comando,
        cpuPorcentaje: cpu,
        memoriaBytes: proceso.rssPaginas * tamanioPagina,
      })
    }

    const n = this.#opciones.topProcesos
    const porCpu = candidatos.toSorted((a, b) => b.cpuPorcentaje - a.cpuPorcentaje).slice(0, n)
    const porMemoria = candidatos.toSorted((a, b) => b.memoriaBytes - a.memoriaBytes).slice(0, n)

    const vistos = new Set<number>()
    const elegidos: Candidato[] = []
    for (const candidato of [...porCpu, ...porMemoria]) {
      if (vistos.has(candidato.pid)) continue
      vistos.add(candidato.pid)
      elegidos.push(candidato)
    }

    // El uid se resuelve recién acá, sobre la veintena que entra al top.
    // Leer /proc/<pid>/status de los mil procesos de la máquina para después
    // descartar 980 costaba más que todo el resto de la muestra junta.
    const usuarios = await this.#usuarios()
    const salida = await Promise.all(
      elegidos.map(async (candidato): Promise<Proceso> => {
        const contenido = await leerOpcional(this.#proc(String(candidato.pid), 'status'))
        const uid = contenido === null ? null : parsearUidProceso(contenido)
        return {
          pid: candidato.pid,
          comando: candidato.comando,
          usuario: uid === null ? '?' : (usuarios.get(uid) ?? String(uid)),
          cpuPorcentaje: candidato.cpuPorcentaje,
          memoriaBytes: candidato.memoriaBytes,
        }
      }),
    )

    this.#capacidades.procesos = salida.length > 0
    return salida
  }

  async muestrear(): Promise<MuestraHost | null> {
    const ahora = Date.now()

    const [statTexto, diskstatsTexto, netdevTexto, loadavgTexto, uptimeTexto] =
      await Promise.all([
        leerOpcional(this.#proc('stat')),
        leerOpcional(this.#proc('diskstats')),
        this.#leerDelHost('net', 'dev'),
        leerOpcional(this.#proc('loadavg')),
        leerOpcional(this.#proc('uptime')),
      ])

    if (statTexto === null) {
      throw new Error(
        `No se puede leer ${this.#proc('stat')}. ¿Está montado /proc del host?`,
      )
    }

    const stat = parsearStat(statTexto)
    const discos = diskstatsTexto === null ? [] : parsearDiskstats(diskstatsTexto)
    const red = netdevTexto === null ? [] : parsearNetDev(netdevTexto)
    const procesos = await this.#leerProcesos()

    this.#capacidades.ioDisco = discos.length > 0

    const previa = this.#previa
    this.#previa = { en: ahora, stat, discos, red, procesos }

    // Primera lectura: sólo deja la base para la próxima. Todo lo que se
    // muestra son tasas y sin dos puntos no hay tasa.
    if (previa === null) return null

    const segundos = (ahora - previa.en) / 1000
    if (segundos <= 0) return null

    const [memoria, filesystems, presion, tcp, temperaturas, sistema] = await Promise.all([
      this.#memoria(),
      this.#filesystems(),
      this.#presion(),
      this.#tcp(),
      this.#temperaturas(),
      this.#identidad(),
    ])

    const discosDerivados = derivarDiscos(discos, previa.discos, segundos)
    this.#capacidades.latenciaIo = discosDerivados.some((d) => d.latenciaLecturaMs !== null)

    const carga = loadavgTexto === null
      ? { uno: 0, cinco: 0, quince: 0 }
      : parsearLoadavg(loadavgTexto)

    const topProcesos = await this.#topProcesos(
      procesos,
      previa.procesos,
      segundos,
      TAMANIO_PAGINA,
    )

    return {
      hostId: await this.hostId(),
      ts: new Date(ahora).toISOString(),
      cpu: derivarCpuCompleto(stat, previa.stat),
      carga: { ...carga, nucleos: sistema.nucleos },
      memoria,
      uptimeSegundos: uptimeTexto === null ? 0 : parsearUptime(uptimeTexto),
      filesystems,
      discos: discosDerivados,
      red: derivarRed(red, previa.red, segundos),
      tcp,
      procesos: topProcesos,
      presion,
      temperaturas,
      sistema,
      capacidades: this.capacidades(),
    }
  }
}

/**
 * Tamaño de página para convertir el RSS de /proc/<pid>/stat a bytes.
 *
 * Es 4096 en x86_64 y en la enorme mayoría de arm64. Node no expone
 * `sysconf(_SC_PAGESIZE)`, y errarle acá sólo desplaza la memoria por proceso
 * del top, no ninguna métrica del sistema.
 */
const TAMANIO_PAGINA = 4096
