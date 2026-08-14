// @ts-check
import { createHash } from 'node:crypto'
import { defineConfig } from 'astro/config'
import node from '@astrojs/node'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { SCRIPT_TEMA } from './src/tema/script.mjs'

/**
 * Hash del script del tema, para el CSP.
 *
 * El script va inline en el `<head>` con `is:inline` porque tiene que correr
 * antes del primer pintado; eso lo deja fuera del pipeline de Astro, así que su
 * hash hay que declararlo a mano. Se calcula del mismo string que se inyecta,
 * de modo que no se pueden desincronizar.
 */
const hashTema = /** @type {`sha256-${string}`} */ (
  `sha256-${createHash('sha256').update(SCRIPT_TEMA).digest('base64')}`
)

/**
 * vmstats — aplicación web.
 *
 * `output: 'server'` porque acá casi nada es estático: el dashboard depende de
 * la sesión y las páginas se arman con datos de la VM.
 *
 * Sobre el CSP: lo emite Astro, no el middleware. Astro conoce el hash de los
 * scripts inline con los que hidrata las islas de React, y una política escrita
 * a mano los bloquearía — la consola cargaría como HTML muerto, sin ninguna
 * interactividad. El middleware sólo agrega `frame-ancestors`, que es la única
 * directiva que un `<meta>` no puede aplicar. Ver `lib/seguridad.ts`.
 */
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],

  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ],
      scriptDirective: {
        // `kind: 'element'` lo acota a `script-src-elem`, que es lo que aplica
        // a un `<script>` inline. No habilita `eval` ni handlers en atributos.
        hashes: [{ hash: hashTema, kind: 'element' }],
      },
      styleDirective: {
        /* Recharts calcula posiciones y las escribe como estilos inline en el
         * SVG, y no hay forma de conocer esos hashes de antemano. Es una
         * concesión acotada: `script-src` sigue sin `unsafe-inline`, que es
         * donde está el riesgo real. */
        resources: ["'self'", "'unsafe-inline'"],
      },
    },
  },

  vite: {
    plugins: [tailwindcss()],
    // `pg` y argon2 son nativos/CJS: si Vite los pre-empaqueta para el
    // servidor, el binding nativo no resuelve dentro del contenedor.
    ssr: { external: ['pg', '@node-rs/argon2'] },
  },

  /* Shiki resalta sintaxis con estilos inline, que el CSP no permite. La
   * consola no renderiza markdown en ningún lado, así que apagarlo saca un
   * warning del build y algo de peso. */
  markdown: { syntaxHighlight: false },

  server: { host: true, port: 4321 },
  devToolbar: { enabled: false },
  build: { inlineStylesheets: 'auto' },
})
