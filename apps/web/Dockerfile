# syntax=docker/dockerfile:1

# =============================================================================
# Imagen del proceso web.
#
# El contexto de build es la RAÍZ del monorepo, no esta carpeta: `npm ci` con
# workspaces necesita ver todos los package.json a la vez para resolver un
# árbol de dependencias consistente.
#
# Este contenedor NUNCA recibe acceso al Docker socket. Los logs de contenedor
# se los pide al collector por su API interna. Ver docs/security.md.
# =============================================================================

# --- Dependencias ------------------------------------------------------------
FROM node:22-alpine AS dependencias
WORKDIR /app

# Sólo los manifiestos: mientras no cambien, esta capa se reutiliza y `npm ci`
# no vuelve a correr aunque cambie todo el código.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY apps/web/package.json ./apps/web/
COPY apps/collector/package.json ./apps/collector/

RUN npm ci --include=dev

# --- Build -------------------------------------------------------------------
FROM dependencias AS build
WORKDIR /app

# Sólo `tsconfig.base.json`: el `tsconfig.json` de la raíz es un agregador de
# project references que apunta también a apps/collector, y esta imagen no lo
# copia. Vite lo resuelve igual y falla con "Tsconfig not found".
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# Los paquetes compilan a dist/ y web los consume desde ahí.
RUN npm run build --workspace=@vmstats/shared \
 && npm run build --workspace=@vmstats/db \
 && npm run build --workspace=@vmstats/web

# Fuera todo lo que sólo hacía falta para compilar. El binding nativo de
# argon2 es una dependencia normal, así que sobrevive a la poda.
RUN npm prune --omit=dev

# --- Runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

# `tini` como PID 1: sin él, Node no recibe SIGTERM correctamente y Docker
# termina matando el proceso a los 10 segundos en cada despliegue.
RUN apk add --no-cache tini

# Se copia el árbol entero desde el build: `COPY --from` conserva los symlinks
# de los workspaces, que es lo que hace que `@vmstats/db` resuelva.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json

USER node
EXPOSE 4321

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrar y después servir. Encadenado y no en dos servicios porque el orden
# importa: un servidor que atiende contra un esquema viejo devuelve errores de
# columna inexistente. Las migraciones son idempotentes.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node packages/db/dist/migrate.js && node apps/web/dist/server/entry.mjs"]
