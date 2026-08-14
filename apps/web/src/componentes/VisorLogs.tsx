import { useState } from 'react'
import { FileTextIcon, LoaderCircleIcon, ShieldIcon } from 'lucide-react'
import { esquemaError, esquemaLogsContenedor, formatearHora, type LogsContenedor } from '@vmstats/shared'
import { Button } from '@/components/ui/button'
import { Aviso } from '@/components/ui/varios'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Visor de logs del inspector.
 *
 * Los logs se piden explícitamente, no al abrir el inspector: traer logs de
 * cada contenedor que alguien mira de paso es tráfico y exposición innecesarios.
 *
 * Se renderizan como texto. Nunca con `dangerouslySetInnerHTML`, ni acá ni en
 * ningún otro lugar del proyecto — el contenido de un log es, por definición,
 * texto que un tercero controla.
 *
 * Vienen ya redactados por el collector. El contador de redacciones se muestra
 * para que nadie crea que está viendo el log crudo.
 * ========================================================================== */

interface Props {
  contenedorId: string
  zonaHoraria: string
}

const LINEAS_POR_DEFECTO = 200

export function VisorLogs({ contenedorId, zonaHoraria }: Props) {
  const [logs, setLogs] = useState<LogsContenedor | null>(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function traer(): Promise<void> {
    setCargando(true)
    setError(null)

    try {
      const respuesta = await fetch(
        `/api/contenedores/${encodeURIComponent(contenedorId)}/logs?lineas=${LINEAS_POR_DEFECTO}`,
      )
      const cuerpo: unknown = await respuesta.json()

      if (!respuesta.ok) {
        const parseado = esquemaError.safeParse(cuerpo)
        setError(
          parseado.success ? parseado.data.mensaje : 'No se pudieron traer los logs.',
        )
        return
      }

      const validado = esquemaLogsContenedor.safeParse(cuerpo)
      if (!validado.success) {
        setError('El servidor devolvió los logs con una forma inesperada.')
        return
      }
      setLogs(validado.data)
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setCargando(false)
    }
  }

  return (
    <section aria-label="Logs recientes" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs font-medium">Logs recientes</h3>
        <Button tamanio="sm" variante="contorno" onClick={() => void traer()} disabled={cargando}>
          {cargando ? (
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          ) : (
            <FileTextIcon aria-hidden />
          )}
          {logs === null ? 'Traer logs' : 'Actualizar'}
        </Button>
      </div>

      {error !== null && (
        <Aviso variante="aviso" role="status">
          {error}
        </Aviso>
      )}

      {logs === null && error === null && (
        <p className="text-muted-foreground text-xs">
          No se descargan solos. Se piden, se muestran y no se guardan.
        </p>
      )}

      {logs !== null && (
        <>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span>{logs.lineas.length} líneas</span>
            {logs.truncado && <span>· recortado por el límite</span>}
            {logs.redacciones > 0 && (
              <span className="text-aviso inline-flex items-center gap-1">
                <ShieldIcon aria-hidden className="size-3" />
                {logs.redacciones}{' '}
                {logs.redacciones === 1 ? 'fragmento redactado' : 'fragmentos redactados'}
              </span>
            )}
          </div>

          {logs.lineas.length === 0 ? (
            <p className="text-muted-foreground text-sm">El contenedor no escribió nada.</p>
          ) : (
            <div className="border-border bg-muted/30 max-h-80 overflow-y-auto rounded-md border">
              <ol className="divide-border/50 divide-y font-mono text-xs">
                {logs.lineas.map((linea, i) => (
                  <li
                    key={i}
                    className={cn(
                      'flex gap-2 px-2 py-1',
                      linea.flujo === 'stderr' && 'bg-critico-suave/40',
                    )}
                  >
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {linea.ts === null ? '--:--' : formatearHora(linea.ts, zonaHoraria)}
                    </span>
                    {linea.flujo === 'stderr' && (
                      <span className="text-critico shrink-0">err</span>
                    )}
                    {/* Texto plano. Se preserva el espaciado y se permite el
                        corte de líneas largas para no desbordar el panel. */}
                    <span className="min-w-0 break-all whitespace-pre-wrap">{linea.texto}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  )
}
