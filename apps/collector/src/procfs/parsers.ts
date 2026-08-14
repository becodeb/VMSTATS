/* ============================================================================
 * Parsers de /proc y /sys.
 *
 * Todas las funciones de este archivo son puras: reciben el *contenido* del
 * archivo como string y devuelven datos. Ninguna toca el disco.
 *
 * Eso es deliberado. El collector corre en Linux, pero el desarrollo y los
 * tests corren donde sea; con los parsers separados de la lectura, se testean
 * contra fixtures reales de /proc en cualquier plataforma. La capa que toca el
 * filesystem vive en `lectura.ts` y no tiene lógica que valga la pena testear.
 *
 * Casi todo /proc son contadores acumulados desde el arranque. Los parsers
 * devuelven esos crudos; convertir dos lecturas en una tasa es trabajo de
 * `derivar.ts`, que es donde vive la aritmética delicada.
 * ========================================================================== */

/** Un entero, o null si el campo no está o no es numérico. */
function entero(texto: string | undefined): number | null {
  if (texto === undefined) return null
  const n = Number.parseInt(texto, 10)
  return Number.isFinite(n) ? n : null
}

function decimal(texto: string | undefined): number | null {
  if (texto === undefined) return null
  const n = Number.parseFloat(texto)
  return Number.isFinite(n) ? n : null
}

function campos(linea: string): string[] {
  return linea.trim().split(/\s+/)
}

/* -------------------------------------------------------------------------
 * /proc/stat
 * ---------------------------------------------------------------------- */

/** Jiffies acumulados por modo. Todo en USER_HZ desde el arranque. */
export interface TiemposCpu {
  user: number
  nice: number
  system: number
  idle: number
  iowait: number
  irq: number
  softirq: number
  steal: number
}

export interface EstadoStat {
  total: TiemposCpu
  porNucleo: TiemposCpu[]
  /** Cambios de contexto acumulados; útil como señal de thrashing. */
  cambiosContexto: number | null
  procesosCorriendo: number | null
  procesosBloqueados: number | null
}

function tiemposDesdeCampos(c: readonly string[]): TiemposCpu {
  // Los kernels viejos publican menos columnas: los faltantes valen 0, que es
  // lo correcto — "no existe esa categoría acá" y "no se consumió tiempo en
  // esa categoría" dan la misma tasa.
  return {
    user: entero(c[0]) ?? 0,
    nice: entero(c[1]) ?? 0,
    system: entero(c[2]) ?? 0,
    idle: entero(c[3]) ?? 0,
    iowait: entero(c[4]) ?? 0,
    irq: entero(c[5]) ?? 0,
    softirq: entero(c[6]) ?? 0,
    steal: entero(c[7]) ?? 0,
  }
}

export function parsearStat(contenido: string): EstadoStat {
  const porNucleo: TiemposCpu[] = []
  let total: TiemposCpu | null = null
  let cambiosContexto: number | null = null
  let procesosCorriendo: number | null = null
  let procesosBloqueados: number | null = null

  for (const linea of contenido.split('\n')) {
    const c = campos(linea)
    const clave = c[0]
    if (clave === undefined) continue

    if (clave === 'cpu') {
      total = tiemposDesdeCampos(c.slice(1))
    } else if (/^cpu\d+$/.test(clave)) {
      porNucleo.push(tiemposDesdeCampos(c.slice(1)))
    } else if (clave === 'ctxt') {
      cambiosContexto = entero(c[1])
    } else if (clave === 'procs_running') {
      procesosCorriendo = entero(c[1])
    } else if (clave === 'procs_blocked') {
      procesosBloqueados = entero(c[1])
    }
  }

  return {
    total: total ?? tiemposDesdeCampos([]),
    porNucleo,
    cambiosContexto,
    procesosCorriendo,
    procesosBloqueados,
  }
}

/* -------------------------------------------------------------------------
 * /proc/meminfo
 * ---------------------------------------------------------------------- */

export interface MemInfo {
  total: number
  libre: number
  /** MemAvailable: la estimación del kernel de cuánto se puede pedir sin
   *  entrar en swap. Es la métrica correcta para "memoria disponible";
   *  MemFree subestima porque no cuenta la cache reclamable. */
  disponible: number
  buffers: number
  cache: number
  swapTotal: number
  swapLibre: number
}

/**
 * meminfo viene en kB (con esa etiqueta literal), no en KiB de verdad — la
 * unidad del kernel es 1024 bytes pese al rótulo. Devolvemos bytes.
 */
export function parsearMeminfo(contenido: string): MemInfo {
  const valores = new Map<string, number>()

  for (const linea of contenido.split('\n')) {
    const separador = linea.indexOf(':')
    if (separador < 0) continue
    const clave = linea.slice(0, separador).trim()
    const resto = campos(linea.slice(separador + 1))
    const n = entero(resto[0])
    if (n === null) continue
    // La unidad siempre es kB cuando está presente; si falta, ya son bytes.
    valores.set(clave, resto[1] === 'kB' ? n * 1024 : n)
  }

  const leer = (clave: string): number => valores.get(clave) ?? 0
  const total = leer('MemTotal')
  const libre = leer('MemFree')
  const cache = leer('Cached') + leer('SReclaimable')

  return {
    total,
    libre,
    // Kernels anteriores a 3.14 no publican MemAvailable. La aproximación
    // clásica es libre + buffers + cache; sobreestima, pero es infinitamente
    // mejor que reportar sólo MemFree.
    disponible: valores.get('MemAvailable') ?? libre + leer('Buffers') + cache,
    buffers: leer('Buffers'),
    cache,
    swapTotal: leer('SwapTotal'),
    swapLibre: leer('SwapFree'),
  }
}

/* -------------------------------------------------------------------------
 * /proc/loadavg y /proc/uptime
 * ---------------------------------------------------------------------- */

export interface LoadAvg {
  uno: number
  cinco: number
  quince: number
}

export function parsearLoadavg(contenido: string): LoadAvg {
  const c = campos(contenido)
  return {
    uno: decimal(c[0]) ?? 0,
    cinco: decimal(c[1]) ?? 0,
    quince: decimal(c[2]) ?? 0,
  }
}

/** Primer campo de /proc/uptime: segundos desde el arranque, con decimales. */
export function parsearUptime(contenido: string): number {
  return decimal(campos(contenido)[0]) ?? 0
}

/* -------------------------------------------------------------------------
 * /proc/diskstats
 * ---------------------------------------------------------------------- */

export interface StatsDisco {
  dispositivo: string
  lecturas: number
  sectoresLeidos: number
  msLeyendo: number
  escrituras: number
  sectoresEscritos: number
  msEscribiendo: number
  /** Tiempo con al menos una operación en vuelo. Base de la utilización. */
  msEnIo: number
}

/** El kernel reporta sectores de 512 bytes acá, sea cual sea el sector físico. */
export const BYTES_POR_SECTOR = 512

/**
 * Filtra particiones y dispositivos virtuales.
 *
 * Sumar `sda` y `sda1` contaría la misma escritura dos veces, y `loop0` de un
 * snap infla los totales con I/O que no toca el disco real.
 */
export function esDispositivoReal(nombre: string): boolean {
  if (/^(loop|ram|fd|dm-|sr|zram)\d*$/.test(nombre)) return false
  // Particiones: sda1, nvme0n1p2, mmcblk0p1.
  if (/^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+)\d+$/.test(nombre)) return false
  if (/^nvme\d+n\d+p\d+$/.test(nombre)) return false
  if (/^mmcblk\d+p\d+$/.test(nombre)) return false
  return true
}

export function parsearDiskstats(contenido: string): StatsDisco[] {
  const salida: StatsDisco[] = []

  for (const linea of contenido.split('\n')) {
    const c = campos(linea)
    // major minor nombre + 11 campos mínimos (kernel >= 2.6).
    if (c.length < 14) continue
    const dispositivo = c[2]
    if (dispositivo === undefined || !esDispositivoReal(dispositivo)) continue

    salida.push({
      dispositivo,
      lecturas: entero(c[3]) ?? 0,
      sectoresLeidos: entero(c[5]) ?? 0,
      msLeyendo: entero(c[6]) ?? 0,
      escrituras: entero(c[7]) ?? 0,
      sectoresEscritos: entero(c[9]) ?? 0,
      msEscribiendo: entero(c[10]) ?? 0,
      msEnIo: entero(c[12]) ?? 0,
    })
  }

  return salida
}

/* -------------------------------------------------------------------------
 * /proc/net/dev
 * ---------------------------------------------------------------------- */

export interface StatsRed {
  interfaz: string
  rxBytes: number
  rxPaquetes: number
  rxErrores: number
  rxDescartes: number
  txBytes: number
  txPaquetes: number
  txErrores: number
  txDescartes: number
}

/**
 * Qué interfaces vale la pena mostrar.
 *
 * `lo` se descarta: el tráfico de loopback no consume red y sólo infla el
 * gráfico.
 *
 * Los `veth*` también, y ésa es la parte que importa: Docker crea un par
 * virtual por contenedor, así que un host con cuarenta contenedores lista
 * cuarenta interfaces y las reales quedan enterradas. Su tráfico ya se ve
 * agregado en `docker0`, que sí se conserva.
 */
export function esInterfazReportable(nombre: string): boolean {
  if (nombre === 'lo') return false
  if (/^veth[0-9a-f]+$/i.test(nombre)) return false
  if (/^(br-[0-9a-f]{12}|virbrd+-nic)$/i.test(nombre)) return false
  return true
}

export function parsearNetDev(contenido: string): StatsRed[] {
  const salida: StatsRed[] = []

  for (const linea of contenido.split('\n')) {
    const separador = linea.indexOf(':')
    if (separador < 0) continue
    const interfaz = linea.slice(0, separador).trim()
    if (interfaz.length === 0 || !esInterfazReportable(interfaz)) continue

    const c = campos(linea.slice(separador + 1))
    if (c.length < 16) continue

    salida.push({
      interfaz,
      rxBytes: entero(c[0]) ?? 0,
      rxPaquetes: entero(c[1]) ?? 0,
      rxErrores: entero(c[2]) ?? 0,
      rxDescartes: entero(c[3]) ?? 0,
      txBytes: entero(c[8]) ?? 0,
      txPaquetes: entero(c[9]) ?? 0,
      txErrores: entero(c[10]) ?? 0,
      txDescartes: entero(c[11]) ?? 0,
    })
  }

  return salida
}

/* -------------------------------------------------------------------------
 * /proc/pressure/*
 * ---------------------------------------------------------------------- */

export interface LineaPresion {
  avg10: number
  avg60: number
  avg300: number
}

export interface PresionArchivo {
  some: LineaPresion | null
  full: LineaPresion | null
}

/**
 * PSI: porcentaje de tiempo en que hubo tareas demoradas por falta del recurso.
 *
 * `some` = al menos una tarea esperando. `full` = todas esperando, o sea que la
 * máquina no avanzó nada. `/proc/pressure/cpu` no tiene `full` en la mayoría de
 * los kernels, y todo el archivo falta si el kernel se compiló sin PSI.
 */
export function parsearPresion(contenido: string): PresionArchivo {
  let some: LineaPresion | null = null
  let full: LineaPresion | null = null

  for (const linea of contenido.split('\n')) {
    const c = campos(linea)
    const tipo = c[0]
    if (tipo !== 'some' && tipo !== 'full') continue

    const valores: Record<string, number> = {}
    for (const campo of c.slice(1)) {
      const [clave, valor] = campo.split('=')
      if (clave === undefined || valor === undefined) continue
      const n = Number.parseFloat(valor)
      if (Number.isFinite(n)) valores[clave] = n
    }

    const linea3: LineaPresion = {
      avg10: valores['avg10'] ?? 0,
      avg60: valores['avg60'] ?? 0,
      avg300: valores['avg300'] ?? 0,
    }
    if (tipo === 'some') some = linea3
    else full = linea3
  }

  return { some, full }
}

/* -------------------------------------------------------------------------
 * /proc/net/tcp y /proc/net/tcp6
 * ---------------------------------------------------------------------- */

export interface ConteoTcp {
  establecidas: number
  escuchando: number
  timeWait: number
  total: number
}

/** Códigos de estado de sockets del kernel, en hexadecimal. */
const TCP_ESTABLISHED = '01'
const TCP_TIME_WAIT = '06'
const TCP_LISTEN = '0A'

/**
 * Cuenta sockets por estado. Se le pasan los contenidos de `tcp` y `tcp6`
 * juntos porque el total le interesa al operador sumado, no por familia.
 */
export function parsearTcp(contenidos: readonly string[]): ConteoTcp {
  let establecidas = 0
  let escuchando = 0
  let timeWait = 0
  let total = 0

  for (const contenido of contenidos) {
    for (const linea of contenido.split('\n')) {
      const c = campos(linea)
      // La primera columna es "N:" (índice). El encabezado empieza con "sl".
      if (c.length < 4 || c[0] === 'sl') continue
      const estado = c[3]?.toUpperCase()
      if (estado === undefined || estado.length !== 2) continue

      total += 1
      if (estado === TCP_ESTABLISHED) establecidas += 1
      else if (estado === TCP_LISTEN) escuchando += 1
      else if (estado === TCP_TIME_WAIT) timeWait += 1
    }
  }

  return { establecidas, escuchando, timeWait, total }
}

/* -------------------------------------------------------------------------
 * /proc/mounts
 * ---------------------------------------------------------------------- */

export interface Montaje {
  dispositivo: string
  puntoMontaje: string
  tipo: string
  opciones: string[]
}

/**
 * Pseudo-filesystems que no representan almacenamiento.
 *
 * Sin este filtro la vista de discos se llena de treinta líneas de `cgroup`,
 * `overlay` por contenedor y `tmpfs` de sistema, y el disco de verdad se pierde
 * en el medio.
 */
const TIPOS_IGNORADOS = new Set([
  'autofs', 'binfmt_misc', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs',
  'devpts', 'devtmpfs', 'efivarfs', 'fuse.gvfsd-fuse', 'fusectl', 'hugetlbfs',
  'mqueue', 'nsfs', 'overlay', 'proc', 'pstore', 'ramfs', 'rpc_pipefs',
  'securityfs', 'selinuxfs', 'sysfs', 'tracefs',
])

/**
 * Filesystems que están al 100 % por diseño.
 *
 * Una imagen `squashfs` de un snap o un `iso9660` montado no tienen espacio
 * libre nunca: están comprimidos y sellados. Listarlos como discos llenos
 * dispara una alerta crítica permanente que no se puede resolver, y a la
 * semana el operador ignora todas las alertas de disco.
 */
const TIPOS_SOLO_LECTURA = new Set(['squashfs', 'iso9660', 'erofs', 'cramfs'])

export function esFilesystemDeSoloLectura(tipo: string): boolean {
  return TIPOS_SOLO_LECTURA.has(tipo)
}

export function esFilesystemReportable(montaje: Montaje): boolean {
  if (TIPOS_IGNORADOS.has(montaje.tipo)) return false
  if (esFilesystemDeSoloLectura(montaje.tipo)) return false
  // tmpfs sólo interesa cuando es /dev/shm o /run: llenarlos rompe cosas.
  if (montaje.tipo === 'tmpfs') {
    return montaje.puntoMontaje === '/dev/shm' || montaje.puntoMontaje === '/run'
  }
  // Los montajes internos del propio Docker no son almacenamiento del host.
  if (montaje.puntoMontaje.startsWith('/var/lib/docker/')) return false
  if (montaje.puntoMontaje.startsWith('/snap/')) return false
  return true
}

/** Los espacios y tabs en las rutas vienen escapados en octal. */
function desescapar(ruta: string): string {
  return ruta.replace(/\\(\d{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

export function parsearMounts(contenido: string): Montaje[] {
  const salida: Montaje[] = []
  const vistos = new Set<string>()

  for (const linea of contenido.split('\n')) {
    const c = campos(linea)
    if (c.length < 4) continue
    const [dispositivo, punto, tipo, opciones] = c
    if (dispositivo === undefined || punto === undefined || tipo === undefined) continue

    const puntoMontaje = desescapar(punto)
    // Un mismo punto puede aparecer dos veces (bind mounts, remounts). Nos
    // quedamos con el primero: es el montaje efectivo.
    if (vistos.has(puntoMontaje)) continue
    vistos.add(puntoMontaje)

    salida.push({
      dispositivo: desescapar(dispositivo),
      puntoMontaje,
      tipo,
      opciones: opciones === undefined ? [] : opciones.split(','),
    })
  }

  return salida
}

/* -------------------------------------------------------------------------
 * /proc/<pid>/stat y /proc/<pid>/status
 * ---------------------------------------------------------------------- */

export interface StatProceso {
  pid: number
  comando: string
  /** utime + stime acumulados, en jiffies. */
  jiffies: number
  /** Jiffies desde el arranque del sistema hasta que arrancó el proceso. */
  arranque: number
  rssPaginas: number
}

/**
 * El campo `comm` viene entre paréntesis y puede contener espacios y hasta
 * paréntesis — `(Web Content)`, `(a)b)`. Por eso se busca el ÚLTIMO `)` en vez
 * de partir por espacios: partir por espacios corre todos los índices y
 * termina leyendo el rss de otra columna.
 */
export function parsearStatProceso(contenido: string): StatProceso | null {
  const abre = contenido.indexOf('(')
  const cierra = contenido.lastIndexOf(')')
  if (abre < 0 || cierra < abre) return null

  const pid = entero(contenido.slice(0, abre).trim())
  const comando = contenido.slice(abre + 1, cierra)
  const resto = campos(contenido.slice(cierra + 1))
  if (pid === null) return null

  // Índices relativos al primer campo después de `)`, que es `state` (campo 3
  // del formato). utime es el 14, stime el 15, starttime el 22, rss el 24.
  const utime = entero(resto[11]) ?? 0
  const stime = entero(resto[12]) ?? 0

  return {
    pid,
    comando,
    jiffies: utime + stime,
    arranque: entero(resto[19]) ?? 0,
    rssPaginas: entero(resto[21]) ?? 0,
  }
}

/** El Uid real es el primero de los cuatro de la línea `Uid:`. */
export function parsearUidProceso(contenido: string): number | null {
  for (const linea of contenido.split('\n')) {
    if (!linea.startsWith('Uid:')) continue
    return entero(campos(linea.slice(4))[0])
  }
  return null
}

/* -------------------------------------------------------------------------
 * Identidad del sistema
 * ---------------------------------------------------------------------- */

/** `PRETTY_NAME` de /etc/os-release, sin comillas. */
export function parsearOsRelease(contenido: string): string | null {
  for (const linea of contenido.split('\n')) {
    if (!linea.startsWith('PRETTY_NAME=')) continue
    const valor = linea.slice('PRETTY_NAME='.length).trim()
    return valor.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return null
}

/** Los sensores del kernel reportan milésimas de grado. */
export function parsearTemperatura(contenido: string): number | null {
  const n = entero(contenido.trim())
  if (n === null) return null
  const celsius = n / 1000
  // Un sensor desconectado devuelve valores absurdos; mejor «no disponible»
  // que un panel diciendo que la VM está a 8000 grados.
  if (celsius < -50 || celsius > 200) return null
  return celsius
}

/** Mapa clave=valor de /proc/net/sockstat, para el conteo barato de TCP. */
export function parsearSockstat(contenido: string): Map<string, number> {
  const salida = new Map<string, number>()
  for (const linea of contenido.split('\n')) {
    const separador = linea.indexOf(':')
    if (separador < 0) continue
    const familia = linea.slice(0, separador).trim()
    const c = campos(linea.slice(separador + 1))
    for (let i = 0; i + 1 < c.length; i += 2) {
      const clave = c[i]
      const valor = entero(c[i + 1])
      if (clave === undefined || valor === null) continue
      salida.set(`${familia}.${clave}`, valor)
    }
  }
  return salida
}
