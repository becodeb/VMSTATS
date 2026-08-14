import { Buffer } from 'node:buffer'
import type { LineaLog, LogsContenedor } from '@vmstats/shared'
import { redactar } from '@vmstats/shared'
import type { ClienteDocker } from './cliente.js'

/* ============================================================================
 * Logs de contenedor, bajo demanda.
 *
 * Tres reglas que la spec fija y que se cumplen acá:
 *   1. No se guardan. Se piden, se muestran y se olvidan.
 *   2. Tienen tope de líneas y de bytes.
 *   3. Pasan por el redactor antes de salir del proceso.
 *
 * La cuarta la cumple la UI: se renderizan como texto, nunca con
 * `dangerouslySetInnerHTML`.
 * ========================================================================== */

/** Cabecera de multiplexado de Docker cuando el contenedor no tiene TTY. */
const TAMANIO_CABECERA = 8

interface Fragmento {
  flujo: 'stdout' | 'stderr'
  texto: string
}

/**
 * Separa el stream multiplexado de Docker.
 *
 * Sin TTY, Docker intercala tramas de `[tipo, 0, 0, 0, largo:uint32BE]` seguidas
 * del payload. Con TTY el stream es texto plano. Distinguimos por la forma de
 * la primera cabecera: si el primer byte no es 0, 1 o 2, o el largo declarado
 * se pasa del buffer, es texto plano.
 */
export function separarFlujos(cuerpo: Buffer): Fragmento[] {
  const fragmentos: Fragmento[] = []
  let posicion = 0

  while (posicion + TAMANIO_CABECERA <= cuerpo.length) {
    const tipo = cuerpo[posicion]
    const largo = cuerpo.readUInt32BE(posicion + 4)

    const cabeceraPlausible =
      (tipo === 0 || tipo === 1 || tipo === 2) &&
      cuerpo[posicion + 1] === 0 &&
      cuerpo[posicion + 2] === 0 &&
      cuerpo[posicion + 3] === 0 &&
      posicion + TAMANIO_CABECERA + largo <= cuerpo.length

    if (!cabeceraPlausible) {
      // Contenedor con TTY: todo el resto es texto plano de stdout.
      return [
        ...fragmentos,
        { flujo: 'stdout', texto: cuerpo.subarray(posicion).toString('utf8') },
      ]
    }

    const inicio = posicion + TAMANIO_CABECERA
    fragmentos.push({
      flujo: tipo === 2 ? 'stderr' : 'stdout',
      texto: cuerpo.subarray(inicio, inicio + largo).toString('utf8'),
    })
    posicion = inicio + largo
  }

  return fragmentos
}

/** Docker antepone un RFC3339Nano cuando se piden timestamps. */
const RE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s([\s\S]*)$/

/* Códigos de control que nos interesan, por número para no depender de
 * escapes en el código fuente. */
const ESC = 0x1b
const TAB = 0x09
const DEL = 0x7f
const CORCHETE = 0x5b

/**
 * Deja el texto apto para renderizar en el inspector.
 *
 * Saca dos cosas: las secuencias de escape ANSI (colores, movimientos de
 * cursor) que descolocarían el layout, y los caracteres de control. Los
 * segundos importan por seguridad además de por estética: un retorno de carro
 * bien puesto permite tapar la línea anterior, así que alguien que pueda
 * escribir en el log de un contenedor podría dibujar una consola falsa.
 *
 * Es un escáner a mano en vez de un par de expresiones regulares porque las
 * regex necesitan caracteres de control literales en el fuente, y esos
 * sobreviven mal a linters, editores y cambios de encoding.
 */
export function limpiarTexto(texto: string): string {
  let salida = ''

  for (let i = 0; i < texto.length; i += 1) {
    const codigo = texto.charCodeAt(i)

    // CSI: ESC [ ... y una letra final en el rango @-~.
    if (codigo === ESC && texto.charCodeAt(i + 1) === CORCHETE) {
      let j = i + 2
      while (j < texto.length) {
        const final = texto.charCodeAt(j)
        if (final >= 0x40 && final <= 0x7e) break
        j += 1
      }
      // Secuencia sin terminador: es basura hasta el final, se descarta.
      i = j
      continue
    }

    // Un ESC suelto tampoco tiene nada que hacer en la pantalla.
    if (codigo === ESC) continue
    if (codigo === DEL) continue
    if (codigo < 0x20 && codigo !== TAB) continue

    salida += texto[i]
  }

  return salida
}

export function parsearLineas(fragmentos: readonly Fragmento[]): LineaLog[] {
  const lineas: LineaLog[] = []

  for (const fragmento of fragmentos) {
    for (const cruda of fragmento.texto.split('\n')) {
      if (cruda.length === 0) continue
      const coincidencia = RE_TIMESTAMP.exec(cruda)

      if (coincidencia === null) {
        lineas.push({ ts: null, flujo: fragmento.flujo, texto: limpiarTexto(cruda) })
        continue
      }

      const marca = coincidencia[1]
      const resto = coincidencia[2] ?? ''
      const fecha = marca === undefined ? null : new Date(marca)
      lineas.push({
        ts: fecha === null || Number.isNaN(fecha.getTime()) ? null : fecha.toISOString(),
        flujo: fragmento.flujo,
        texto: limpiarTexto(resto),
      })
    }
  }

  return lineas
}

export interface OpcionesLogs {
  maxLineas: number
  maxBytes: number
}

/**
 * Trae las últimas líneas de un contenedor, redactadas.
 *
 * El tope de bytes se aplica en el cliente HTTP (corta la conexión) y el de
 * líneas en el propio Docker vía `tail`, así que ninguno de los dos depende de
 * que el contenedor se porte bien.
 */
export async function traerLogs(
  cliente: ClienteDocker,
  contenedorId: string,
  opciones: OpcionesLogs,
): Promise<LogsContenedor> {
  const ruta =
    `/containers/${encodeURIComponent(contenedorId)}/logs` +
    `?stdout=1&stderr=1&timestamps=1&tail=${opciones.maxLineas}`

  const cuerpo = await cliente.getCrudo(ruta, opciones.maxBytes)
  const truncadoPorBytes = cuerpo.length >= opciones.maxBytes

  const lineas = parsearLineas(separarFlujos(cuerpo))
  // Si se cortó por bytes, la primera línea puede haber quedado partida al
  // medio; se descarta para no mostrar un fragmento sin principio.
  const utiles = truncadoPorBytes ? lineas.slice(1) : lineas

  let redacciones = 0
  const redactadas = utiles.slice(-opciones.maxLineas).map((linea): LineaLog => {
    const resultado = redactar(linea.texto)
    redacciones += resultado.redacciones
    return { ...linea, texto: resultado.texto }
  })

  return {
    contenedorId,
    lineas: redactadas,
    truncado: truncadoPorBytes || utiles.length > opciones.maxLineas,
    redacciones,
  }
}
