# syntax=docker/dockerfile:1

# =============================================================================
# Imagen del collector.
#
# El contexto de build es la RAÍZ del monorepo. Es el único proceso con acceso
# a Docker —a través del proxy de sólo lectura— y el único que lee /proc del
# host.
# =============================================================================

# --- Dependencias ------------------------------------------------------------
FROM node:22-alpine AS dependencias
WORKDIR /app

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
# project references que apunta también a apps/web, y esta imagen no lo
# copia. Vite lo resuelve igual y falla con "Tsconfig not found".
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/collector ./apps/collector

RUN npm run build --workspace=@vmstats/shared \
 && npm run build --workspace=@vmstats/db \
 && npm run build --workspace=@vmstats/collector \
 && npm prune --omit=dev

# --- Runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/collector/dist ./apps/collector/dist
COPY --from=build --chown=node:node /app/apps/collector/package.json ./apps/collector/package.json

USER node

# El healthcheck es un comando, no un endpoint: la spec pide que el collector
# no exponga puertos, y comprobar el archivo de vida detecta además el caso de
# un proceso vivo pero trabado — que un chequeo de PID no vería.
HEALTHCHECK --interval=20s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "apps/collector/dist/salud.js"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/collector/dist/main.js"]
