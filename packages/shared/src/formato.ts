/* ============================================================================
 * Formato de números y unidades.
 *
 * Todo lo que se muestra pasa por acá: en una consola de telemetría la unidad
 * es parte del dato, y un `0.8` sin contexto no dice nada.
 * ========================================================================== */

const LOCALE = 'es-AR'

/**
 * Normaliza los espacios raros que mete `Intl`.
 *
 * Node y los navegadores traen versiones distintas de ICU, y no coinciden en
 * qué espacio usan: para `es-AR`, Node emite U+00A0 antes de «a. m.» donde
 * Chrome emite U+202F. Los dos textos se ven idénticos en pantalla, pero son
 * bytes distintos.
 *
 * Eso rompe la hidratación: React compara el HTML del servidor contra lo que
 * produce el cliente, ve textos diferentes y descarta el árbol entero — la
 * consola se vuelve a construir desde cero en cada carga. Costó encontrarlo
 * justamente porque a simple vista no hay ninguna diferencia.
 *
 * Con todo pasado a espacio normal, servidor y cliente producen exactamente lo
 * mismo. Ver el test de hidratación en `e2e/consola.spec.ts`.
 *
 * La clase de caracteres se arma por código y no como literal en la expresión
 * regular: son invisibles, y dejarlos escritos en el fuente es exactamente el
 * tipo de cosa que esta función existe para evitar.
 */
const ESPACIOS_RAROS = new RegExp(
  `[${String.fromCharCode(0x00a0, 0x202f, 0x2009, 0x2007)}]`,
  'g',
)

function normalizarEspacios(texto: string): string {
  return texto.replace(ESPACIOS_RAROS, ' ')
}

/** Base 1024, nomenclatura corta. Los discos y la RAM se miden así. */
const UNIDADES_BYTES = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

export function formatearBytes(valor: number | null, decimales = 1): string {
  if (valor === null || !Number.isFinite(valor)) return '—'
  if (valor === 0) return '0 B'
  const signo = valor < 0 ? '-' : ''
  const abs = Math.abs(valor)
  const indice = Math.min(
    UNIDADES_BYTES.length - 1,
    Math.floor(Math.log(abs) / Math.log(1024)),
  )
  const escalado = abs / 1024 ** indice
  // Los bytes crudos no llevan decimales: "512 B", no "512,0 B".
  const dec = indice === 0 ? 0 : decimales
  return normalizarEspacios(
    `${signo}${escalado.toLocaleString(LOCALE, {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    })} ${UNIDADES_BYTES[indice]}`,
  )
}

export function formatearTasa(bytesPorSeg: number | null): string {
  if (bytesPorSeg === null || !Number.isFinite(bytesPorSeg)) return '—'
  return `${formatearBytes(bytesPorSeg)}/s`
}

export function formatearPorcentaje(valor: number | null, decimales = 1): string {
  if (valor === null || !Number.isFinite(valor)) return '—'
  return normalizarEspacios(
    `${valor.toLocaleString(LOCALE, {
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    })} %`,
  )
}

export function formatearNumero(valor: number | null, decimales = 2): string {
  if (valor === null || !Number.isFinite(valor)) return '—'
  return normalizarEspacios(
    valor.toLocaleString(LOCALE, {
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    }),
  )
}

export function formatearEntero(valor: number | null): string {
  if (valor === null || !Number.isFinite(valor)) return '—'
  return normalizarEspacios(Math.round(valor).toLocaleString(LOCALE))
}

/**
 * Duración legible, de mayor a menor unidad y como mucho dos tramos.
 * `95000` -> «1 d 2 h». Un uptime con segundos no aporta nada.
 */
export function formatearDuracion(segundos: number | null): string {
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0) return '—'
  const s = Math.floor(segundos)
  if (s < 60) return `${s} s`

  const dias = Math.floor(s / 86_400)
  const horas = Math.floor((s % 86_400) / 3600)
  const minutos = Math.floor((s % 3600) / 60)
  const segs = s % 60

  if (dias > 0) return horas > 0 ? `${dias} d ${horas} h` : `${dias} d`
  if (horas > 0) return minutos > 0 ? `${horas} h ${minutos} min` : `${horas} h`
  return segs > 0 ? `${minutos} min ${segs} s` : `${minutos} min`
}

/** «hace 12 s», para la última muestra. */
export function formatearHace(fecha: Date | null, ahora: Date = new Date()): string {
  if (fecha === null) return 'nunca'
  const segundos = Math.max(0, Math.round((ahora.getTime() - fecha.getTime()) / 1000))
  if (segundos < 5) return 'recién'
  return `hace ${formatearDuracion(segundos)}`
}

export function formatearFechaHora(fecha: Date | string | null, zona: string): string {
  if (fecha === null) return '—'
  const d = typeof fecha === 'string' ? new Date(fecha) : fecha
  if (Number.isNaN(d.getTime())) return '—'
  return normalizarEspacios(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: zona,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(d),
  )
}

export function formatearHora(fecha: Date | string | null, zona: string): string {
  if (fecha === null) return '—'
  const d = typeof fecha === 'string' ? new Date(fecha) : fecha
  if (Number.isNaN(d.getTime())) return '—'
  return normalizarEspacios(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: zona,
      hour: '2-digit',
      minute: '2-digit',
    }).format(d),
  )
}

/** Los hashes de commit se muestran a 7, como en git. */
export function commitCorto(commit: string | null): string {
  return commit === null || commit.length === 0 ? '—' : commit.slice(0, 7)
}

export function porcentajeDe(parte: number, total: number): number | null {
  if (!Number.isFinite(parte) || !Number.isFinite(total) || total <= 0) return null
  return (parte / total) * 100
}
