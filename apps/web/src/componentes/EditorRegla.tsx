import { useState, type FormEvent } from 'react'
import {
  CLAVES_METRICA_ALERTA,
  METRICAS_ALERTA,
  esquemaEntradaReglaAlerta,
  type EntradaReglaAlerta,
  type MetricaAlerta,
  type ReglaAlerta,
} from '@vmstats/shared'
import { InspectorLateral } from '@/componentes/InspectorLateral'
import { Button } from '@/components/ui/button'
import { Aviso, Campo, Rotulo } from '@/components/ui/varios'

/* ============================================================================
 * Editor de regla de alerta.
 *
 * Los cinco parámetros que gobiernan el ruido —umbral, duración mínima,
 * cooldown, histéresis y severidad— están todos acá, cada uno con la
 * explicación de qué problema resuelve. Una regla mal configurada no falla:
 * simplemente genera alertas que nadie mira, y ése es el modo de falla real de
 * un sistema de alertas.
 *
 * Se valida con el mismo esquema Zod que usa el servidor, así que lo que pasa
 * acá pasa allá.
 * ========================================================================== */

interface Props {
  /** null = crear una nueva. */
  regla: ReglaAlerta | null
  onCerrar: () => void
  onGuardar: (valores: EntradaReglaAlerta) => void | Promise<void>
}

const VALORES_INICIALES: EntradaReglaAlerta = {
  nombre: '',
  metrica: 'cpu.total',
  operador: 'mayor',
  umbral: 85,
  severidad: 'warning',
  duracionMinimaSegundos: 300,
  cooldownSegundos: 600,
  histeresis: 5,
  habilitada: true,
  silenciadaHasta: null,
}

export function EditorRegla({ regla, onCerrar, onGuardar }: Props) {
  const inicial: EntradaReglaAlerta =
    regla === null
      ? VALORES_INICIALES
      : {
          nombre: regla.nombre,
          metrica: regla.metrica,
          operador: regla.operador,
          umbral: regla.umbral,
          severidad: regla.severidad,
          duracionMinimaSegundos: regla.duracionMinimaSegundos,
          cooldownSegundos: regla.cooldownSegundos,
          histeresis: regla.histeresis,
          habilitada: regla.habilitada,
          silenciadaHasta: regla.silenciadaHasta,
        }

  const [valores, setValores] = useState<EntradaReglaAlerta>(inicial)
  const [error, setError] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)

  const unidad = METRICAS_ALERTA[valores.metrica].unidad

  function cambiar<K extends keyof EntradaReglaAlerta>(
    clave: K,
    valor: EntradaReglaAlerta[K],
  ): void {
    setValores((previos) => ({ ...previos, [clave]: valor }))
  }

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault()
    setError(null)

    const validado = esquemaEntradaReglaAlerta.safeParse(valores)
    if (!validado.success) {
      setError(validado.error.issues[0]?.message ?? 'Revisá los valores.')
      return
    }

    setGuardando(true)
    try {
      await onGuardar(validado.data)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <InspectorLateral
      abierto
      titulo={regla === null ? 'Nueva regla' : 'Editar regla'}
      subtitulo={regla?.nombre}
      onCerrar={onCerrar}
    >
      <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-5" noValidate>
        {error !== null && (
          <Aviso variante="critico" role="alert">
            {error}
          </Aviso>
        )}

        <div className="flex flex-col gap-2">
          <Rotulo htmlFor="nombre">Nombre</Rotulo>
          <Campo
            id="nombre"
            value={valores.nombre}
            onChange={(e) => cambiar('nombre', e.target.value)}
            maxLength={120}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Rotulo htmlFor="metrica">Métrica</Rotulo>
          <select
            id="metrica"
            value={valores.metrica}
            onChange={(e) => cambiar('metrica', e.target.value as MetricaAlerta)}
            className="border-input bg-card focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
          >
            {CLAVES_METRICA_ALERTA.map((clave) => (
              <option key={clave} value={clave}>
                {METRICAS_ALERTA[clave].etiqueta}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Rotulo htmlFor="operador">Condición</Rotulo>
            <select
              id="operador"
              value={valores.operador}
              onChange={(e) => cambiar('operador', e.target.value === 'menor' ? 'menor' : 'mayor')}
              className="border-input bg-card focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
            >
              <option value="mayor">Mayor que</option>
              <option value="menor">Menor que</option>
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <Rotulo htmlFor="umbral">Umbral {unidad === '' ? '' : `(${unidad})`}</Rotulo>
            <Campo
              id="umbral"
              type="number"
              step="any"
              value={valores.umbral}
              onChange={(e) => cambiar('umbral', Number(e.target.value))}
              required
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Rotulo htmlFor="severidad">Severidad</Rotulo>
          <select
            id="severidad"
            value={valores.severidad}
            onChange={(e) =>
              cambiar('severidad', e.target.value === 'critical' ? 'critical' : 'warning')
            }
            className="border-input bg-card focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
          >
            <option value="warning">Advertencia</option>
            <option value="critical">Crítica</option>
          </select>
        </div>

        <fieldset className="flex flex-col gap-4">
          <legend className="text-muted-foreground mb-1 text-xs font-medium">
            Control de ruido
          </legend>

          <CampoNumerico
            id="duracion"
            etiqueta="Duración mínima (segundos)"
            ayuda="Cuánto tiene que sostenerse la condición antes de disparar. Evita que un pico de cinco segundos genere una alerta."
            valor={valores.duracionMinimaSegundos}
            onCambiar={(v) => cambiar('duracionMinimaSegundos', v)}
            min={0}
            max={86400}
          />

          <CampoNumerico
            id="cooldown"
            etiqueta="Cooldown (segundos)"
            ayuda="Tras resolverse, cuánto esperar antes de poder volver a disparar."
            valor={valores.cooldownSegundos}
            onCambiar={(v) => cambiar('cooldownSegundos', v)}
            min={0}
            max={86400}
          />

          <CampoNumerico
            id="histeresis"
            etiqueta={`Histéresis ${unidad === '' ? '' : `(${unidad})`}`}
            ayuda={`Margen que hay que cruzar de vuelta para cerrar la alerta. Con ${valores.histeresis}, la alerta abre en ${valores.umbral} y recién cierra en ${
              valores.operador === 'mayor'
                ? valores.umbral - valores.histeresis
                : valores.umbral + valores.histeresis
            }. Sin esto, un valor oscilando alrededor del umbral genera alertas en ráfaga.`}
            valor={valores.histeresis}
            onCambiar={(v) => cambiar('histeresis', v)}
            min={0}
            max={1e9}
          />
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={valores.habilitada}
            onChange={(e) => cambiar('habilitada', e.target.checked)}
            className="border-input accent-primary focus-visible:ring-ring size-4 rounded outline-none focus-visible:ring-2"
          />
          Regla habilitada
        </label>

        <div className="border-border flex gap-2 border-t pt-4">
          <Button type="submit" variante="primario" disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button type="button" variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      </form>
    </InspectorLateral>
  )
}

function CampoNumerico({
  id,
  etiqueta,
  ayuda,
  valor,
  onCambiar,
  min,
  max,
}: {
  id: string
  etiqueta: string
  ayuda: string
  valor: number
  onCambiar: (valor: number) => void
  min: number
  max: number
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Rotulo htmlFor={id}>{etiqueta}</Rotulo>
      <Campo
        id={id}
        type="number"
        value={valor}
        min={min}
        max={max}
        step="any"
        onChange={(e) => onCambiar(Number(e.target.value))}
        aria-describedby={`${id}-ayuda`}
      />
      {/* La ayuda va asociada por `aria-describedby`, no sólo debajo: para un
          lector de pantalla, un texto suelto después del input no pertenece al
          campo. */}
      <p id={`${id}-ayuda`} className="text-muted-foreground text-xs">
        {ayuda}
      </p>
    </div>
  )
}
