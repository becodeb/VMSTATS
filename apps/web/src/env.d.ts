/// <reference types="astro/client" />

import type { SesionActiva } from './lib/sesion.js'
import type { ClaveActiva } from './lib/clavesApi.js'

declare global {
  namespace App {
    interface Locals {
      /**
       * Sesión de navegador validada, o null.
       *
       * Deliberadamente NO se rellena con una clave de API disfrazada: de ella
       * se deriva el token CSRF y la vida de la cookie, dos cosas que no
       * existen para un cliente programático. Para saber quién está pidiendo
       * algo, usá `identidad`.
       */
      sesion: SesionActiva | null
      /** Clave de API validada, o null. Sólo puede aparecer en rutas `/api/`. */
      claveApi: ClaveActiva | null
      /** Quién hace el pedido, venga de donde venga. Null si nadie. */
      identidad: Identidad | null
      /** Token CSRF de esta sesión. Cadena vacía sin sesión de navegador. */
      csrf: string
    }

    interface Identidad {
      usuarioId: string
      email: string
      nombre: string
      rol: string
      /** Con qué credencial llegó. Se audita, para distinguir persona de script. */
      via: 'sesion' | 'clave'
    }
  }
}

export {}
