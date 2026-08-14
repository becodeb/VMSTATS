import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/* ============================================================================
 * Cifra con `number-pop-in`.
 *
 * La transición de transitions.dev, con una restricción propia importante: no
 * se dispara en cada actualización. La consola recibe una muestra cada cinco
 * segundos, y animar los dígitos cada vez haría el número ilegible — que es
 * exactamente lo que la spec advierte sobre `spinning-counter`.
 *
 * Sólo se anima cuando el cambio es *relevante*: un salto mayor al umbral que
 * define quien la usa. Un 42,1 % que pasa a 42,3 % no es noticia; un 42 % que
 * pasa a 91 % sí.
 * ========================================================================== */

interface Props {
  /** El valor ya formateado, tal como se va a mostrar. */
  texto: string
  /** El valor numérico, para decidir si el cambio amerita animar. */
  valor?: number | null
  /**
   * Cambio mínimo para animar, como fracción del valor anterior.
   *
   * Es relativo y no absoluto: un umbral fijo funciona para porcentajes pero
   * es inservible para bytes por segundo, donde cualquier variación normal se
   * mide en millones y el número terminaría animándose en cada muestra —
   * exactamente el efecto que la spec pide evitar.
   */
  umbral?: number
  className?: string
}

/** 25 %: por debajo de eso, el cambio es ruido de la medición. */
const UMBRAL_POR_DEFECTO = 0.25

export function Cifra({ texto, valor = null, umbral = UMBRAL_POR_DEFECTO, className }: Props) {
  const [animando, setAnimando] = useState(false)
  const anterior = useRef<number | null>(valor)
  const grupo = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (valor === null) return
    const previo = anterior.current
    anterior.current = valor

    if (previo === null) return

    // El denominador nunca es cero, y valores diminutos no disparan animación
    // por cambios que en términos absolutos son irrelevantes.
    const referencia = Math.max(1, Math.abs(previo))
    if (Math.abs(valor - previo) / referencia < umbral) return

    // Reinicio del ciclo de animación: quitar la clase, forzar reflow y
    // volver a ponerla. Sin el reflow el navegador agrupa los dos cambios de
    // clase y la animación no se vuelve a ejecutar.
    setAnimando(false)
    void grupo.current?.offsetHeight
    setAnimando(true)

    const fin = setTimeout(() => setAnimando(false), 900)
    return () => clearTimeout(fin)
  }, [valor, umbral])

  const caracteres = [...texto]

  return (
    <span
      ref={grupo}
      className={cn('t-digit-group cifra', animando && 'is-animating', className)}
    >
      {caracteres.map((caracter, i) => (
        <span
          key={`${i}-${caracter}`}
          className="t-digit"
          // Los dos últimos dígitos entran escalonados: es lo que le da al
          // número la sensación de "aterrizar" en vez de aparecer de golpe.
          {...(i === caracteres.length - 2
            ? { 'data-stagger': '1' }
            : i === caracteres.length - 1
              ? { 'data-stagger': '2' }
              : {})}
        >
          {caracter === ' ' ? ' ' : caracter}
        </span>
      ))}
    </span>
  )
}
