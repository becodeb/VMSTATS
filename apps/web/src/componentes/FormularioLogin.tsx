import { useState, type FormEvent } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { esquemaError } from '@vmstats/shared'
import { useMontado } from '@/hooks/useMontado'
import { Button } from '@/components/ui/button'
import { Aviso, Campo, Rotulo } from '@/components/ui/varios'

/* ============================================================================
 * Formulario de inicio de sesión.
 *
 * El único error que se muestra es el que devuelve el servidor, que es siempre
 * el mismo para email inexistente y contraseña incorrecta. Acá no se hace
 * ninguna validación que pueda revelar más que eso.
 *
 * Sobre el envío antes de hidratar
 * -------------------------------
 * Este formulario se manda por `fetch`, pero entre que el servidor pinta el
 * HTML y React engancha el `onSubmit` hay una ventana. Si alguien aprieta Enter
 * ahí —o un test automatizado, que es como apareció— el navegador hace el
 * submit nativo.
 *
 * Sin `method`, ese submit nativo es GET, y GET pone los campos en la query
 * string: la contraseña terminaba en la barra de direcciones, en el historial,
 * en los logs del proxy y en la cabecera `Referer` del siguiente pedido.
 *
 * Dos capas para que no vuelva a pasar:
 *
 *   1. `method="post"`. Aunque el submit nativo ocurra, los campos viajan en el
 *      cuerpo. Nunca en una URL.
 *   2. El botón queda deshabilitado hasta que el componente montó. Cerrar la
 *      ventana es mejor que sobrevivirla.
 *
 * La primera es la que importa: es la que sigue protegiendo si la segunda falla.
 * ========================================================================== */

interface Props {
  /** Adónde ir después de entrar. Lo pone el servidor desde `?siguiente=`. */
  siguiente: string
}

export function FormularioLogin({ siguiente }: Props) {
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const montado = useMontado()

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
    <form
      onSubmit={(e) => void enviar(e)}
      /* `method` y `action` son la red de contención del submit nativo, no la
       * vía normal: si React ya enganchó, `preventDefault` corre antes y esto
       * no se usa nunca. Si no enganchó, los campos van en el cuerpo de un POST
       * y la página vuelve a pintarse. */
      method="post"
      action="/login"
      className="flex flex-col gap-4"
      noValidate
    >
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

      <Button
        type="submit"
        variante="primario"
        disabled={enviando || !montado}
        className="mt-2 w-full"
      >
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
