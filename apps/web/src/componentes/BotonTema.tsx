import { MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTema } from '@/tema/tema'

/**
 * Alterna claro y oscuro.
 *
 * Los dos íconos están siempre montados y se cruzan por rotación y escala — es
 * la transición `icon-swap` de transitions.dev: el ícono nuevo entra mientras
 * el viejo sale, sin el parpadeo de desmontar y montar. Portado de Panky sin
 * cambios de comportamiento.
 */
export function BotonTema() {
  const { resuelto, alternar } = useTema()
  const aOscuro = resuelto !== 'oscuro'

  return (
    <Button
      variante="fantasma"
      tamanio="icono"
      onClick={alternar}
      aria-label={aOscuro ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro'}
      title={aOscuro ? 'Tema oscuro' : 'Tema claro'}
    >
      <span className="relative grid size-5 place-items-center">
        <SunIcon
          aria-hidden
          className="col-start-1 row-start-1 size-4 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{
            transform: aOscuro ? 'none' : 'rotate(-90deg) scale(0.4)',
            opacity: aOscuro ? 1 : 0,
          }}
        />
        <MoonIcon
          aria-hidden
          className="col-start-1 row-start-1 size-4 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{
            transform: aOscuro ? 'rotate(90deg) scale(0.4)' : 'none',
            opacity: aOscuro ? 0 : 1,
          }}
        />
      </span>
    </Button>
  )
}
