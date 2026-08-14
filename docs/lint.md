# Reglas de lint desactivadas y por qué

`.oxlintrc.json` no admite comentarios, así que las excepciones se justifican
acá. Cada una está apagada por una razón concreta, no por conveniencia.

| Regla | Por qué está apagada |
| --- | --- |
| `react/react-in-jsx-scope` | Es del transform JSX clásico. El proyecto usa el automático (`jsx: "react-jsx"`), donde `React` no tiene que estar en el alcance. |
| `eslint/no-await-in-loop` | Los `await` en bucle de este código son secuencias con orden: pasos de un test, o inserciones que dependen de la anterior. Paralelizarlos cambiaría el significado. |
| `react/no-array-index-key` | Donde se usa el índice como clave, el índice **es** la identidad: el núcleo 0 es el núcleo 0, y una línea de log no tiene identificador. Las listas se reemplazan enteras en cada actualización. |
| `import/no-named-as-default-member` | `pg` es CommonJS. El import por defecto con desestructuración es el patrón que documentan pg y Drizzle para ESM; los named imports fallan según el bundler, y ese fallo aparece recién dentro del contenedor. |
| `import/no-unassigned-import` | `import '@/styles/global.css'` es cómo se importa una hoja de estilos. |
| `jsx-a11y/prefer-tag-over-role` | Pide `<dialog>` en vez de `role="dialog"` y `<meter>` en vez de `role="meter"`. `<dialog>` cambia el comportamiento (top layer, `::backdrop`) y rompe la transición `panel-reveal`; `role="img"` sobre un `<svg>` es el patrón estándar de SVG accesible. |
| `jsx-a11y/no-noninteractive-element-to-interactive-role` | El patrón ARIA de listbox usa `<ul role="listbox">` con `<li>`. Es lo que recomienda la propia especificación de ARIA. |
| `jsx-a11y/heading-has-content` y `label-has-associated-control` | Falsos positivos sobre componentes genéricos (`<h3 {...props} />`): la regla no puede ver los hijos que llegan por props. |
| `react/no-unstable-nested-components` (con `allowAsProps`) | Las funciones `render:` de `TablaAdaptable` son props de datos, no componentes: describen cómo pintar una celda. |

La accesibilidad no se apoya en el linter: se verifica en `e2e/consola.spec.ts`
con un navegador de verdad (foco, `tablist`, trampa de foco del inspector,
alternativa en tabla de los gráficos).
