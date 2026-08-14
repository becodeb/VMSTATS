import { baseDesdeUrl, type BaseDatos } from '@vmstats/db'
import type pg from 'pg'
import { entorno } from './entorno.js'

/* ============================================================================
 * Pool de PostgreSQL del proceso web.
 *
 * Un único pool para todo el proceso. Astro en modo servidor mantiene el
 * módulo vivo entre requests, así que crear el pool por request abriría y
 * cerraría conexiones en cada carga de página.
 * ========================================================================== */

let instancia: { pool: pg.Pool; db: BaseDatos } | null = null

function crear(): { pool: pg.Pool; db: BaseDatos } {
  if (instancia !== null) return instancia
  // Pool chico a propósito: el dashboard hace consultas cortas y el SSE usa
  // una conexión dedicada aparte, fuera del pool.
  instancia = baseDesdeUrl({ url: entorno().DATABASE_URL, maxConexiones: 8 })
  return instancia
}

export function base(): BaseDatos {
  return crear().db
}

export function pool(): pg.Pool {
  return crear().pool
}
