import { useCallback, useEffect, useState } from 'react'
import { BellOffIcon, CheckIcon, PencilIcon, RefreshCwIcon, TrashIcon } from 'lucide-react'
import { z } from 'zod'
import type { InstanciaAlerta, ReglaAlerta } from '@vmstats/shared'
import {
  METRICAS_ALERTA,
  esquemaError,
  esquemaInstanciaAlerta,
  esquemaReglaAlerta,
  formatearDuracion,
  formatearFechaHora,
  formatearEntero,
  formatearNumero,
  formatearTasa,
  umbralDeSalida,
} from '@vmstats/shared'
import { Bloque, Vacio } from '@/componentes/bloques'
import { PuntoEstado } from '@/componentes/estado'
import { Tostadas, useTostadas } from '@/componentes/Tostadas'
import { EditorRegla } from '@/componentes/EditorRegla'
import { Button } from '@/components/ui/button'
import { Aviso, Esqueleto, Etiqueta } from '@/components/ui/varios'

/* ============================================================================
 * Alertas.
 *
 * Tres cosas en una vista: lo que está sonando, lo que sonó hace poco, y las
 * reglas que definen cuándo suena.
 *
 * Ninguna acción manda una notificación a ningún lado. La spec lo prohíbe por
 * defecto y no existe integración de salida en el código.
 * ========================================================================== */

const esquemaRespuesta = z.object({
  abiertas: z.array(esquemaInstanciaAlerta),
  resueltas: z.array(esquemaInstanciaAlerta),
  reglas: z.array(esquemaReglaAlerta),
})

const SILENCIOS = [
  { minutos: 60, etiqueta: '1 hora' },
  { minutos: 480, etiqueta: '8 horas' },
  { minutos: 1440, etiqueta: '1 día' },
] as const

/**
 * Valor con su unidad, con los decimales que la métrica amerita.
 *
 * Un contador de contenedores caídos se lee «1», no «1,00»; un porcentaje sí
 * quiere un decimal. Sin esto, la mitad de las alertas muestra precisión que
 * no existe.
 */
function valorConUnidad(valor: number, unidad: string): string {
  if (unidad === 'B/s') return formatearTasa(valor)
  if (unidad === '') {
    return Number.isInteger(valor) ? formatearEntero(valor) : formatearNumero(valor, 2)
  }
  return `${formatearNumero(valor, 1)} ${unidad}`
}

interface Props {
  csrf: string
  zonaHoraria: string
}

export function Alertas({ csrf, zonaHoraria }: Props) {
  const [datos, setDatos] = useState<z.infer<typeof esquemaRespuesta> | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editando, setEditando] = useState<ReglaAlerta | 'nueva' | null>(null)
  const { tostadas, mostrar, quitar } = useTostadas()

  const cargar = useCallback(async () => {
    setError(null)
    try {
      const respuesta = await fetch('/api/alertas')
      if (!respuesta.ok) {
        setError('No se pudieron cargar las alertas.')
        return
      }
      const validado = esquemaRespuesta.safeParse(await respuesta.json())
      if (!validado.success) {
        setError('El servidor devolvió datos con una forma inesperada.')
        return
      }
      setDatos(validado.data)
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  const accionar = useCallback(
    async (cuerpo: unknown, exito: string): Promise<boolean> => {
      try {
        const respuesta = await fetch('/api/alertas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-vmstats-csrf': csrf },
          body: JSON.stringify(cuerpo),
        })

        if (!respuesta.ok) {
          const parseado = esquemaError.safeParse(await respuesta.json())
          mostrar('error', parseado.success ? parseado.data.mensaje : 'No se pudo completar.')
          return false
        }

        mostrar('ok', exito)
        await cargar()
        return true
      } catch {
        mostrar('error', 'No se pudo conectar con el servidor.')
        return false
      }
    },
    [csrf, cargar, mostrar],
  )

  if (cargando && datos === null) {
    return (
      <div className="flex flex-col gap-4">
        <Esqueleto className="h-32 w-full" />
        <Esqueleto className="h-64 w-full" />
      </div>
    )
  }

  if (error !== null && datos === null) {
    return (
      <Aviso variante="critico" role="alert">
        <p className="mb-2">{error}</p>
        <Button tamanio="sm" variante="contorno" onClick={() => void cargar()}>
          <RefreshCwIcon aria-hidden /> Reintentar
        </Button>
      </Aviso>
    )
  }

  const abiertas = datos?.abiertas ?? []
  const resueltas = datos?.resueltas ?? []
  const reglas = datos?.reglas ?? []

  return (
    <>
      <Bloque
        titulo="Alertas abiertas"
        nota={abiertas.length === 0 ? 'ninguna' : `${abiertas.length}`}
        acciones={
          <Button tamanio="sm" variante="fantasma" onClick={() => void cargar()}>
            <RefreshCwIcon aria-hidden /> Actualizar
          </Button>
        }
      >
        {abiertas.length === 0 ? (
          <Vacio
            titulo="Nada sonando"
            detalle="Ninguna regla está en condición de alerta en este momento."
          />
        ) : (
          <ul className="divide-border divide-y">
            {abiertas.map((alerta) => (
              <FilaAlerta
                key={alerta.id}
                alerta={alerta}
                zonaHoraria={zonaHoraria}
                onReconocer={() =>
                  void accionar(
                    { accion: 'reconocer', instanciaId: alerta.id },
                    'Alerta reconocida.',
                  )
                }
                onSilenciar={(minutos) =>
                  void accionar(
                    { accion: 'silenciar', reglaId: alerta.reglaId, minutos },
                    `Regla silenciada por ${formatearDuracion(minutos * 60)}.`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </Bloque>

      <Bloque titulo="Resueltas" nota="últimos 7 días">
        {resueltas.length === 0 ? (
          <p className="text-muted-foreground text-sm">Sin alertas resueltas en la semana.</p>
        ) : (
          <ul className="divide-border divide-y">
            {resueltas.map((alerta) => (
              <li
                key={alerta.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <PuntoEstado estado="sin-datos" texto="Resuelta" />
                <span>{alerta.reglaNombre}</span>
                <span className="text-muted-foreground cifra text-xs">
                  {valorConUnidad(alerta.valorDisparo, METRICAS_ALERTA[alerta.metrica].unidad)}
                </span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {formatearFechaHora(alerta.iniciadaEn, zonaHoraria)} →{' '}
                  {formatearFechaHora(alerta.resueltaEn, zonaHoraria)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Bloque>

      <Bloque
        titulo="Reglas"
        nota={`${reglas.length}`}
        acciones={
          <Button tamanio="sm" variante="contorno" onClick={() => setEditando('nueva')}>
            Nueva regla
          </Button>
        }
      >
        <ul className="divide-border divide-y">
          {reglas.map((regla) => (
            <FilaRegla
              key={regla.id}
              regla={regla}
              zonaHoraria={zonaHoraria}
              onEditar={() => setEditando(regla)}
              onAlternar={() =>
                void accionar(
                  {
                    accion: 'editar-regla',
                    reglaId: regla.id,
                    regla: { habilitada: !regla.habilitada },
                  },
                  regla.habilitada ? 'Regla deshabilitada.' : 'Regla habilitada.',
                )
              }
              onQuitarSilencio={() =>
                void accionar(
                  { accion: 'silenciar', reglaId: regla.id, minutos: 0 },
                  'Silencio levantado.',
                )
              }
              onBorrar={() =>
                void accionar(
                  { accion: 'borrar-regla', reglaId: regla.id },
                  'Regla borrada.',
                )
              }
            />
          ))}
        </ul>
      </Bloque>

      {editando !== null && (
        <EditorRegla
          regla={editando === 'nueva' ? null : editando}
          onCerrar={() => setEditando(null)}
          onGuardar={async (valores) => {
            const ok = await accionar(
              editando === 'nueva'
                ? { accion: 'crear-regla', regla: valores }
                : { accion: 'editar-regla', reglaId: editando.id, regla: valores },
              editando === 'nueva' ? 'Regla creada.' : 'Regla actualizada.',
            )
            if (ok) setEditando(null)
          }}
        />
      )}

      <Tostadas tostadas={tostadas} onCerrar={quitar} />
    </>
  )
}

function FilaAlerta({
  alerta,
  zonaHoraria,
  onReconocer,
  onSilenciar,
}: {
  alerta: InstanciaAlerta
  zonaHoraria: string
  onReconocer: () => void
  onSilenciar: (minutos: number) => void
}) {
  const metrica = METRICAS_ALERTA[alerta.metrica]

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PuntoEstado
          estado={alerta.severidad === 'critical' ? 'critico' : 'advertencia'}
          texto={alerta.severidad === 'critical' ? 'Crítica' : 'Advertencia'}
        />
        <span className="text-sm font-medium">{alerta.reglaNombre}</span>
        <Etiqueta variante={alerta.severidad === 'critical' ? 'critica' : 'aviso'}>
          {alerta.severidad === 'critical' ? 'crítica' : 'advertencia'}
        </Etiqueta>
        {alerta.estado === 'reconocida' && <Etiqueta variante="neutra">Reconocida</Etiqueta>}
        <span className="text-muted-foreground ml-auto text-xs">
          desde {formatearFechaHora(alerta.iniciadaEn, zonaHoraria)}
        </span>
      </div>

      <p className="text-muted-foreground text-xs">
        {metrica.etiqueta} llegó a{' '}
        <span className="cifra text-foreground">{valorConUnidad(alerta.valorDisparo, metrica.unidad)}</span>{' '}
        con umbral <span className="cifra">{valorConUnidad(alerta.umbral, metrica.unidad)}</span>.
      </p>

      <div className="flex flex-wrap gap-2">
        {alerta.estado !== 'reconocida' && (
          <Button tamanio="sm" variante="contorno" onClick={onReconocer}>
            <CheckIcon aria-hidden /> Reconocer
          </Button>
        )}
        {SILENCIOS.map((s) => (
          <Button
            key={s.minutos}
            tamanio="sm"
            variante="fantasma"
            onClick={() => onSilenciar(s.minutos)}
          >
            <BellOffIcon aria-hidden /> {s.etiqueta}
          </Button>
        ))}
      </div>
    </li>
  )
}

function FilaRegla({
  regla,
  zonaHoraria,
  onEditar,
  onAlternar,
  onQuitarSilencio,
  onBorrar,
}: {
  regla: ReglaAlerta
  zonaHoraria: string
  onEditar: () => void
  onAlternar: () => void
  onQuitarSilencio: () => void
  onBorrar: () => void
}) {
  const metrica = METRICAS_ALERTA[regla.metrica]
  const silenciada =
    regla.silenciadaHasta !== null && Date.parse(regla.silenciadaHasta) > Date.now()

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{regla.nombre}</span>
        <Etiqueta variante={regla.severidad === 'critical' ? 'critica' : 'aviso'}>
          {regla.severidad === 'critical' ? 'crítica' : 'advertencia'}
        </Etiqueta>
        {!regla.habilitada && <Etiqueta variante="neutra">Deshabilitada</Etiqueta>}
        {silenciada && (
          <Etiqueta variante="neutra">
            <BellOffIcon aria-hidden className="size-3" />
            hasta {formatearFechaHora(regla.silenciadaHasta, zonaHoraria)}
          </Etiqueta>
        )}
      </div>

      <p className="text-muted-foreground cifra text-xs">
        {metrica.etiqueta} {regla.operador === 'mayor' ? '>' : '<'}{' '}
        {valorConUnidad(regla.umbral, metrica.unidad)} durante{' '}
        {formatearDuracion(regla.duracionMinimaSegundos)} · cierra en{' '}
        {valorConUnidad(umbralDeSalida(regla), metrica.unidad)} · cooldown{' '}
        {formatearDuracion(regla.cooldownSegundos)}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button tamanio="sm" variante="fantasma" onClick={onEditar}>
          <PencilIcon aria-hidden /> Editar
        </Button>
        <Button tamanio="sm" variante="fantasma" onClick={onAlternar}>
          {regla.habilitada ? 'Deshabilitar' : 'Habilitar'}
        </Button>
        {silenciada && (
          <Button tamanio="sm" variante="fantasma" onClick={onQuitarSilencio}>
            Quitar silencio
          </Button>
        )}
        <Button tamanio="sm" variante="fantasma" onClick={onBorrar} className="text-critico">
          <TrashIcon aria-hidden /> Borrar
        </Button>
      </div>
    </li>
  )
}
