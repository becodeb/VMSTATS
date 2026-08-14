import { defineConfig } from 'vitest/config'

/* ============================================================================
 * Tests unitarios y de integración.
 *
 * Los unitarios no tocan nada externo: los parsers de /proc, la máquina de
 * alertas, la redacción de secretos y el planificador de resolución son
 * funciones puras, y por eso corren igual en Windows que en el contenedor.
 *
 * Los de integración necesitan PostgreSQL y sólo corren si hay `DATABASE_URL`.
 * Se saltean solos en vez de fallar: un `npm test` en una máquina sin base
 * tiene que decir «no probé esto», no «está roto».
 * ========================================================================== */

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    reporters: process.env['CI'] === 'true' ? ['default'] : ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/collector/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/dist/**'],
    },
  },
})
