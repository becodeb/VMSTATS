import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { esquemaError, formatearFechaHora } from '@vmstats/shared'
import { Button } from '@/components/ui/button'
import { Aviso, Campo, Esqueleto, Etiqueta, Rotulo } from '@/components/ui/varios'

/* ============================================================================
 * Claves de API.
 *
 * Para hablarle a la consola desde un script o un cron. El secreto se muestra
 * una sola vez, cuando se crea, y esta pantalla lo dice antes y después de
 * mostrarlo: no hay forma de recuperarlo, porque la base sólo guarda su hash.
 *
 * El alcance por defecto es `read`. Crear una clave que puede mutar exige
 * elegirlo a propósito, y la pantalla explica qué habilita.
 * ========================================================================== */

const esquemaClave = z.object({
  id: z.string(),
  nombre: z.string(),
  prefijo: z.string(),
  alcance: z.string(),
  creadaEn: z.string(),
  expiraEn: z.string().nullable(),
  usadaEn: z.string().nullable(),
})

const esquemaLista = z.object({ claves: z.array(esquemaClave) })
const esquemaCreada = z.object({ secreto: z.string(), clave: esquemaClave })

type Clave = z.infer<typeof esquemaClave>

/** Opciones de vencimiento. «Sin vencimiento» existe pero no es la primera. */
const VENCIMIENTOS = [
  { etiqueta: '30 días', dias: 30 },
  { etiqueta: '90 días', dias: 90 },
  { etiqueta: '1 año', dias: 365 },
  { etiqueta: 'Sin vencimiento', dias: null },
] as const

interface Props {
  csrf: string
  zonaHoraria: string
}

export function ClavesApi({ csrf, zonaHoraria }: Props) {
  const [claves, setClaves] = useState<Clave[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creando, setCreando] = useState(false)
  const [trabajando, setTrabajando] = useState(false)

  /* El secreto recién creado. Vive sólo en el estado de este componente: no se
   * guarda en ningún lado y desaparece al cerrar el panel o recargar. */
  const [reciente, setReciente] = useState<{ secreto: string; nombre: string } | null>(null)

  const [nombre, setNombre] = useState('')
  const [alcance, setAlcance] = useState<'read' | 'admin'>('read')
  const [dias, setDias] = useState<number | null>(90)
  const [porRevocar, setPorRevocar] = useState<string | null>(null)

  /* El foco se mueve al primer campo cuando el formulario aparece.
   *
   * Con un ref y no con `autoFocus`: el atributo sólo actúa en el montaje
   * inicial del documento, así que en un formulario que aparece y desaparece
   * es poco fiable, y además roba el foco al cargar la página cuando el panel
   * ya estaba abierto. Acá el movimiento es consecuencia directa de que la
   * persona apretó «Nueva», que es cuando corresponde. */
  const campoNombre = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creando) campoNombre.current?.focus()
  }, [creando])

  const cargar = useCallback(async () => {
    try {
      const respuesta = await fetch('/api/claves')
      if (!respuesta.ok) {
        setError('No se pudieron cargar las claves.')
        return
      }
      const validado = esquemaLista.safeParse(await respuesta.json())
      if (!validado.success) {
        setError('El servidor devolvió datos con una forma inesperada.')
        return
      }
      setClaves(validado.data.claves)
      setError(null)
    } catch {
      setError('No se pudo conectar con el servidor.')
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function crear(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault()
    if (nombre.trim().length === 0) {
      setError('Poné un nombre para poder reconocer la clave después.')
      return
    }

    setTrabajando(true)
    setError(null)

    try {
      const respuesta = await fetch('/api/claves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vmstats-csrf': csrf },
        body: JSON.stringify({ nombre: nombre.trim(), alcance, diasValidez: dias }),
      })

      if (!respuesta.ok) {
        const parseado = esquemaError.safeParse(await respuesta.json())
        setError(parseado.success ? parseado.data.mensaje : 'No se pudo crear la clave.')
        return
      }

      const validado = esquemaCreada.safeParse(await respuesta.json())
      if (!validado.success) {
        setError('El servidor devolvió datos con una forma inesperada.')
        return
      }

      setReciente({ secreto: validado.data.secreto, nombre: validado.data.clave.nombre })
      setNombre('')
      setAlcance('read')
      setDias(90)
      setCreando(false)
      await cargar()
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setTrabajando(false)
    }
  }

  async function revocar(id: string): Promise<void> {
    setTrabajando(true)
    setError(null)

    try {
      const respuesta = await fetch('/api/claves', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-vmstats-csrf': csrf },
        body: JSON.stringify({ id }),
      })

      if (!respuesta.ok) {
        const parseado = esquemaError.safeParse(await respuesta.json())
        setError(parseado.success ? parseado.data.mensaje : 'No se pudo revocar.')
        return
      }

      setPorRevocar(null)
      await cargar()
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setTrabajando(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <KeyRoundIcon className="size-4" aria-hidden />
          Claves de API
        </h3>
        {!creando && (
          <Button
            variante="contorno"
            tamanio="sm"
            onClick={() => {
              setCreando(true)
              setError(null)
            }}
          >
            <PlusIcon aria-hidden />
            Nueva
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Para leer métricas desde un script o un cron, sin navegador. Se usan con la
        cabecera <code className="font-mono">Authorization: Bearer …</code>.
      </p>

      {error !== null && (
        <Aviso variante="critico" role="alert">
          {error}
        </Aviso>
      )}

      {/* El secreto, una única vez. */}
      {reciente !== null && (
        <SecretoNuevo
          secreto={reciente.secreto}
          nombre={reciente.nombre}
          onCerrar={() => setReciente(null)}
        />
      )}

      {creando && (
        <form onSubmit={(e) => void crear(e)} className="border-border t-dropdown is-open flex flex-col gap-3 rounded-md border p-3">
          <div className="flex flex-col gap-1.5">
            <Rotulo htmlFor="clave-nombre">Nombre</Rotulo>
            <Campo
              id="clave-nombre"
              ref={campoNombre}
              value={nombre}
              maxLength={80}
              placeholder="cron de backups"
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-foreground mb-1.5 text-sm font-medium">Alcance</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="alcance"
                value="read"
                checked={alcance === 'read'}
                onChange={() => setAlcance('read')}
                className="border-input accent-primary focus-visible:ring-ring mt-0.5 size-4 outline-none focus-visible:ring-2"
              />
              <span>
                Sólo lectura
                <span className="text-muted-foreground block text-xs">
                  Consultar métricas, contenedores, despliegues, alertas e historial.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="alcance"
                value="admin"
                checked={alcance === 'admin'}
                onChange={() => setAlcance('admin')}
                className="border-input accent-primary focus-visible:ring-ring mt-0.5 size-4 outline-none focus-visible:ring-2"
              />
              <span>
                Lectura y escritura
                <span className="text-muted-foreground block text-xs">
                  Además, modificar reglas de alerta, silenciar y cambiar preferencias.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Rotulo htmlFor="clave-vence">Vencimiento</Rotulo>
            <select
              id="clave-vence"
              value={dias === null ? 'nunca' : String(dias)}
              onChange={(e) => setDias(e.target.value === 'nunca' ? null : Number(e.target.value))}
              className="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
            >
              {VENCIMIENTOS.map((v) => (
                <option key={v.etiqueta} value={v.dias === null ? 'nunca' : String(v.dias)}>
                  {v.etiqueta}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variante="fantasma"
              tamanio="sm"
              onClick={() => {
                setCreando(false)
                setError(null)
              }}
            >
              Cancelar
            </Button>
            <Button type="submit" tamanio="sm" disabled={trabajando}>
              {trabajando ? 'Creando…' : 'Crear clave'}
            </Button>
          </div>
        </form>
      )}

      {claves === null ? (
        error === null ? (
          <Esqueleto className="h-16 w-full" />
        ) : null
      ) : claves.length === 0 ? (
        <p className="text-muted-foreground border-border rounded-md border border-dashed px-3 py-4 text-center text-xs">
          No hay claves activas.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {claves.map((clave) => (
            <li
              key={clave.id}
              className="border-border flex flex-col gap-2 rounded-md border px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{clave.nombre}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    vmst_{clave.prefijo}…
                  </p>
                </div>
                <Etiqueta variante={clave.alcance === 'admin' ? 'aviso' : 'neutra'}>
                  {clave.alcance === 'admin' ? 'lectura y escritura' : 'sólo lectura'}
                </Etiqueta>
              </div>

              <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs tabular-nums">
                <dt>Creada</dt>
                <dd>{formatearFechaHora(clave.creadaEn, zonaHoraria)}</dd>
                <dt>Vence</dt>
                <dd>
                  {clave.expiraEn === null
                    ? 'nunca'
                    : formatearFechaHora(clave.expiraEn, zonaHoraria)}
                </dd>
                <dt>Último uso</dt>
                <dd>
                  {clave.usadaEn === null
                    ? 'sin usar'
                    : formatearFechaHora(clave.usadaEn, zonaHoraria)}
                </dd>
              </dl>

              {porRevocar === clave.id ? (
                <div className="border-border flex flex-wrap items-center justify-end gap-2 border-t pt-2">
                  <p className="text-muted-foreground mr-auto text-xs">
                    Deja de funcionar de inmediato.
                  </p>
                  <Button
                    variante="fantasma"
                    tamanio="sm"
                    onClick={() => setPorRevocar(null)}
                  >
                    Cancelar
                  </Button>
                  <Button
                    variante="destructivo"
                    tamanio="sm"
                    disabled={trabajando}
                    onClick={() => void revocar(clave.id)}
                  >
                    Revocar
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end">
                  <Button
                    variante="fantasma"
                    tamanio="sm"
                    onClick={() => setPorRevocar(clave.id)}
                    aria-label={`Revocar la clave ${clave.nombre}`}
                  >
                    <TrashIcon aria-hidden />
                    Revocar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------
 * El secreto recién creado
 * ---------------------------------------------------------------------- */

function SecretoNuevo({
  secreto,
  nombre,
  onCerrar,
}: {
  secreto: string
  nombre: string
  onCerrar: () => void
}) {
  const [copiado, setCopiado] = useState(false)
  const [falloCopia, setFalloCopia] = useState(false)

  async function copiar(): Promise<void> {
    try {
      /* `navigator.clipboard` no existe fuera de un contexto seguro. Si la
       * consola se sirve por HTTP plano —una instalación local, sin TLS— esto
       * falla, y hay que decirlo en vez de dejar un botón que no hace nada:
       * el secreto está a la vista para seleccionarlo a mano. */
      await navigator.clipboard.writeText(secreto)
      setCopiado(true)
      setFalloCopia(false)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      setFalloCopia(true)
    }
  }

  return (
    <div
      className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-md border p-3"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-medium">Clave «{nombre}» creada</p>
      <p className="text-muted-foreground text-xs">
        Copiala ahora. Es la única vez que se muestra: la base guarda solamente su hash,
        así que no se puede recuperar. Si la perdés, revocala y creá otra.
      </p>

      {/* `select-all` para que un clic la seleccione entera; `break-all` para que
          no fuerce scroll horizontal en pantallas angostas. */}
      <code className="border-border bg-background block rounded border px-2 py-1.5 font-mono text-xs break-all select-all">
        {secreto}
      </code>

      {falloCopia && (
        <p className="text-muted-foreground text-xs">
          El navegador no permitió copiar automáticamente. Seleccionala y copiala a mano.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variante="fantasma" tamanio="sm" onClick={onCerrar}>
          Listo, la guardé
        </Button>
        <Button variante="contorno" tamanio="sm" onClick={() => void copiar()}>
          {copiado ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {copiado ? 'Copiada' : 'Copiar'}
        </Button>
      </div>
    </div>
  )
}
