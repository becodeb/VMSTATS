import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/* ============================================================================
 * Tema claro / oscuro.
 *
 * Adaptado del de Panky, con una diferencia obligada por el SSR: allá el
 * estado inicial se leía de `localStorage` en el inicializador de `useState`,
 * lo que en una app renderizada en servidor produce un parpadeo — el HTML
 * llega en claro y React lo corrige después de hidratar.
 *
 * Acá el `.dark` lo pone un script bloqueante en el `<head>` (ver
 * `Base.astro`), antes del primer pintado, y este proveedor arranca leyendo lo
 * que ese script ya dejó en el DOM. Nunca hay un frame con el tema equivocado.
 * ========================================================================== */

import { CLAVE_TEMA } from './script.mjs'

export type Tema = 'claro' | 'oscuro' | 'sistema'

export { CLAVE_TEMA, SCRIPT_TEMA } from './script.mjs'

interface EstadoTema {
  tema: Tema
  /** Lo que efectivamente se muestra, ya resuelto `sistema`. */
  resuelto: 'claro' | 'oscuro'
  setTema: (t: Tema) => void
  alternar: () => void
}

const ContextoTema = createContext<EstadoTema | null>(null)

function leerGuardado(): Tema {
  if (typeof localStorage === 'undefined') return 'sistema'
  const guardado = localStorage.getItem(CLAVE_TEMA)
  return guardado === 'claro' || guardado === 'oscuro' ? guardado : 'sistema'
}

function preferenciaDelSistema(): 'claro' | 'oscuro' {
  if (typeof window === 'undefined') return 'claro'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro'
}

/** Lo que el script del `<head>` ya aplicó. Es la verdad en el primer render. */
function temaEnElDom(): 'claro' | 'oscuro' {
  if (typeof document === 'undefined') return 'claro'
  return document.documentElement.classList.contains('dark') ? 'oscuro' : 'claro'
}

export function ProveedorTema({ children }: { children: ReactNode }) {
  const [tema, setTemaEstado] = useState<Tema>(leerGuardado)
  const [delSistema, setDelSistema] = useState<'claro' | 'oscuro'>(temaEnElDom)

  useEffect(() => {
    setDelSistema(preferenciaDelSistema())
    const consulta = window.matchMedia('(prefers-color-scheme: dark)')
    const alCambiar = () => setDelSistema(consulta.matches ? 'oscuro' : 'claro')
    consulta.addEventListener('change', alCambiar)
    return () => consulta.removeEventListener('change', alCambiar)
  }, [])

  const resuelto = tema === 'sistema' ? delSistema : tema

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resuelto === 'oscuro')
    // `color-scheme` hace que los controles nativos (scrollbars, autocompletado)
    // acompañen al tema en vez de quedar blancos sobre fondo oscuro.
    document.documentElement.style.colorScheme = resuelto === 'oscuro' ? 'dark' : 'light'
  }, [resuelto])

  const setTema = useCallback((t: Tema) => {
    setTemaEstado(t)
    if (t === 'sistema') localStorage.removeItem(CLAVE_TEMA)
    else localStorage.setItem(CLAVE_TEMA, t)
  }, [])

  const alternar = useCallback(() => {
    // Alternar sale del modo automático: si tocás el botón, elegiste.
    setTema(resuelto === 'oscuro' ? 'claro' : 'oscuro')
  }, [resuelto, setTema])

  // Sin memoizar, cada render del proveedor entrega un objeto nuevo y obliga a
  // re-renderizar a todo lo que consume el tema.
  const valor = useMemo(
    () => ({ tema, resuelto, setTema, alternar }),
    [tema, resuelto, setTema, alternar],
  )

  return <ContextoTema value={valor}>{children}</ContextoTema>
}

export function useTema(): EstadoTema {
  const ctx = use(ContextoTema)
  if (ctx === null) throw new Error('useTema tiene que usarse dentro de ProveedorTema')
  return ctx
}
