import { useState, type FormEvent } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { esquemaError } from '@vmstats/shared'
import { Button } from '@/components/ui/button'
import { Aviso, Campo, Rotulo } from '@/components/ui/varios'

/* ============================================================================
 * Formulario de inicio de sesión.
 *
 * El único error que se muestra es el que devuelve el servidor, que es siempre
 * el mismo para email inexistente y contraseña incorrecta. Acá no se hace
 * ninguna validación que pueda revelar más que eso.
 * ========================================================================== */

interface Props {
  /** Adónde ir después de entrar. Lo pone el servidor desde `?siguiente=`. */
  siguiente: string
}

export function FormularioLogin({ siguiente }: Props) {
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function enviar(evento: FormEvent<HTMLFormElement>): Promise<void> {
    evento.preventDefault()
    if (enviando) return

    const datos = new FormData(evento.currentTarget)
    setEnviando(true)
    setError(null)

    try {
      const respuesta = await fetch('/api/sesion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(datos.get('email') ?? ''),
          contrasenia: String(datos.get('contrasenia') ?? ''),
        }),
      })

      if (respuesta.ok) {
        // Navegación completa y no cliente: hace falta que el servidor vuelva a
        // renderizar con la sesión ya establecida.
        window.location.assign(siguiente)
        return
      }

      const cuerpo = esquemaError.safeParse(await respuesta.json())
      setError(
        cuerpo.success ? cuerpo.data.mensaje : 'No se pudo iniciar sesión. Probá de nuevo.',
      )
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-4" noValidate>
      {error !== null && (
        // `assertive` porque es la respuesta directa a la acción del usuario y
        // tiene que interrumpir: sin esto, quien usa lector de pantalla
        // reintenta sin saber que falló.
        <Aviso variante="critico" role="alert" aria-live="assertive">
          {error}
        </Aviso>
      )}

      <div className="flex flex-col gap-2">
        <Rotulo htmlFor="email">Email</Rotulo>
        <Campo
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          disabled={enviando}
          aria-invalid={error !== null}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Rotulo htmlFor="contrasenia">Contraseña</Rotulo>
        <Campo
          id="contrasenia"
          name="contrasenia"
          type="password"
          autoComplete="current-password"
          required
          disabled={enviando}
          aria-invalid={error !== null}
        />
      </div>

      <Button type="submit" variante="primario" disabled={enviando} className="mt-2 w-full">
        {enviando ? (
          <>
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            Entrando…
          </>
        ) : (
          'Entrar'
        )}
      </Button>
    </form>
  )
}
