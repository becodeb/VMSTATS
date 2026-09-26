import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { esquemaError, formatearDuracion, RETENCION_HORAS, type Resolucion } from '@vmstats/shared'
import { ClavesApi } from '@/componentes/ClavesApi'
import { InspectorLateral } from '@/componentes/InspectorLateral'
import { Button } from '@/components/ui/button'
import { Aviso, Campo, Esqueleto, Rotulo } from '@/components/ui/varios'

/* ============================================================================
 * Preferencias de la instancia.
 *
 * Zona horaria de visualización y el interruptor de los logs de contenedor.
 * Es la pantalla a la que apunta el mensaje de error cuando alguien pide logs
 * con la función apagada.
 *
 * La retención se muestra pero no se edita: es fija (RETENCION_HORAS) porque es
 * lo que mantiene acotado el disco de la VM.
 * ========================================================================== */

const esquemaRespuesta = z.object({
  zonaHoraria: z.string(),
  logsHabilitados: z.boolean(),
  logsMaxLineas: z.number(),
  logsMaxBytes: z.number(),
  /** Si esta instancia tiene la API interna del collector configurada. */
  apiInternaConfigurada: z.boolean(),
})

type Preferencias = z.infer<typeof esquemaRespuesta>

const TRAMOS_RETENCION: readonly { resolucion: Resolucion; etiqueta: string }[] = [
  { resolucion: 'raw', etiqueta: 'Datos crudos (host cada 10 s, contenedores cada 30 s)' },
  { resolucion: '5m', etiqueta: 'Agregado de 5 minutos' },
  { resolucion: '15m', etiqueta: 'Agregado de 15 minutos' },
]

/** Zonas frecuentes; se puede escribir cualquier otra válida de la IANA. */
const ZONAS_SUGERIDAS = [
  'America/Miquelon',
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/New_York',
  'Europe/Madrid',
  'UTC',
]

interface Props {
  csrf: string
  onCerrar: () => void
  onGuardado: (zonaHoraria: string) => void
}

export function Preferencias({ csrf, onCerrar, onGuardado }: Props) {
  const [datos, setDatos] = useState<Preferencias | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    try {
      const respuesta = await fetch('/api/preferencias')
      if (!respuesta.ok) {
        setError('No se pudieron cargar las preferencias.')
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
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function guardar(cambios: Partial<Preferencias>): Promise<void> {
    setGuardando(true)
    setError(null)
    setAviso(null)

    try {
      const respuesta = await fetch('/api/preferencias', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-vmstats-csrf': csrf },
        body: JSON.stringify(cambios),
      })

      if (!respuesta.ok) {
        const parseado = esquemaError.safeParse(await respuesta.json())
        setError(parseado.success ? parseado.data.mensaje : 'No se pudo guardar.')
        return
      }

      const validado = esquemaRespuesta.partial().safeParse(await respuesta.json())
      if (validado.success && validado.data.zonaHoraria !== undefined) {
        onGuardado(validado.data.zonaHoraria)
      }

      setAviso('Guardado.')
      await cargar()
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <InspectorLateral abierto titulo="Preferencias" onCerrar={onCerrar}>
      {datos === null ? (
        error === null ? (
          <Esqueleto className="h-64 w-full" />
        ) : (
          <Aviso variante="critico" role="alert">
            {error}
          </Aviso>
        )
      ) : (
        <div className="flex flex-col gap-6">
          {error !== null && (
            <Aviso variante="critico" role="alert">
              {error}
            </Aviso>
          )}
          {aviso !== null && (
            <Aviso variante="neutro" role="status">
              {aviso}
            </Aviso>
          )}

          <section className="flex flex-col gap-2">
            <Rotulo htmlFor="zona">Zona horaria de visualización</Rotulo>
            <Campo
              id="zona"
              list="zonas-sugeridas"
              defaultValue={datos.zonaHoraria}
              onBlur={(e) => {
                if (e.target.value !== datos.zonaHoraria) {
                  void guardar({ zonaHoraria: e.target.value })
                }
              }}
            />
            <datalist id="zonas-sugeridas">
              {ZONAS_SUGERIDAS.map((zona) => (
                <option key={zona} value={zona}>
                  {zona}
                </option>
              ))}
            </datalist>
            <p className="text-muted-foreground text-xs">
              Los datos se guardan siempre en UTC. Esto sólo cambia cómo se muestran.
            </p>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Retención</h3>
            <dl className="flex flex-col gap-1.5">
              {TRAMOS_RETENCION.map(({ resolucion, etiqueta }) => (
                <div key={resolucion} className="flex items-center justify-between gap-3 text-xs">
                  <dt className="min-w-0 flex-1">{etiqueta}</dt>
                  <dd className="text-muted-foreground tabular-nums">
                    {formatearDuracion(RETENCION_HORAS[resolucion] * 3600)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground text-xs">
              El collector agrega y aplica la retención solo, en tandas chicas. Nada se
              guarda más de siete días.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Logs de contenedor</h3>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={datos.logsHabilitados}
                disabled={guardando || !datos.apiInternaConfigurada}
                onChange={(e) => void guardar({ logsHabilitados: e.target.checked })}
                className="border-input accent-primary focus-visible:ring-ring mt-0.5 size-4 rounded outline-none focus-visible:ring-2 disabled:opacity-50"
              />
              <span>
                Permitir ver logs desde el inspector de contenedores
                <span className="text-muted-foreground block text-xs">
                  Vienen apagados. Los logs se piden bajo demanda, no se guardan y pasan por
                  un redactor de secretos antes de llegar al navegador.
                </span>
              </span>
            </label>

            {!datos.apiInternaConfigurada && (
              <Aviso variante="aviso">
                Esta instancia no tiene configurada la API interna del collector, así que los
                logs no están disponibles aunque se habiliten acá. Hace falta definir
                <code className="mx-1 font-mono text-xs">COLLECTOR_TOKEN_INTERNO</code> y
                <code className="mx-1 font-mono text-xs">COLLECTOR_URL_INTERNA</code>. Está
                explicado en docs/security.md.
              </Aviso>
            )}
          </section>

          <div className="border-border border-t pt-5">
            <ClavesApi csrf={csrf} zonaHoraria={datos.zonaHoraria} />
          </div>

          <div className="border-border flex justify-end border-t pt-4">
            <Button variante="contorno" onClick={onCerrar}>
              Cerrar
            </Button>
          </div>
        </div>
      )}
    </InspectorLateral>
  )
}
