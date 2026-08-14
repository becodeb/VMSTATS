# Operación

## Desplegar en Coolify

### 1. Crear el recurso

En Coolify: **New Resource → Docker Compose**, apuntando a este repositorio.
Coolify detecta `docker-compose.yml` en la raíz.

### 2. Variables de entorno

En el panel **Environment Variables** del recurso. Las dos primeras son
obligatorias y el stack no arranca sin ellas.

```sh
# Obligatorias
POSTGRES_PASSWORD=<openssl rand -base64 32>
SESSION_SECRET=<openssl rand -base64 48>

# Recomendadas
PUBLIC_ORIGIN=https://vmstats.tudominio.com
VMSTATS_PUERTO=4321

# Coolify (opcional; sin esto la sección Despliegues queda vacía y lo explica)
COOLIFY_BASE_URL=https://coolify.tudominio.com
COOLIFY_API_TOKEN=<token con permiso `read`>

# Logs de contenedor (opcional)
COLLECTOR_TOKEN_INTERNO=<openssl rand -base64 48>
```

El token de Coolify se crea en **Keys & Tokens → API tokens**. Alcanza con
`read`; **no** le des `read:sensitive` (ver [security.md](./security.md)).

### 3. Dominio y despliegue

Asignale un dominio al servicio `web` en Coolify — el proxy de Coolify se encarga
del TLS. Después, **Deploy**.

El contenedor web aplica las migraciones antes de levantar el servidor. Es
idempotente: se puede redesplegar cuantas veces haga falta.

### 4. Crear el primer administrador

vmstats no crea credenciales por defecto. Una vez desplegado:

```sh
docker compose exec -it web node packages/db/dist/bootstrap.js
```

Pide email, nombre y contraseña (mínimo 12 caracteres). Si no tenés terminal
interactiva, la alternativa por entorno está en `.env.example`; acordate de
**borrar esas variables después**.

### 5. Comprobar

```sh
docker compose ps                    # los cuatro servicios, web y collector "healthy"
curl -s localhost:4321/api/salud     # {"estado":"ok"}
docker compose logs collector | tail # sin errores
```

En la consola, la franja superior debería mostrar «En vivo» y la última muestra
con fecha reciente.

---

## Backup y restore de PostgreSQL

El volumen `postgres-datos` guarda todo. **No se publica el puerto de la base**,
así que el backup se hace desde adentro del contenedor.

### Backup

```sh
# Volcado completo, comprimido, con fecha
docker compose exec -T postgres pg_dump -U vmstats -d vmstats -Fc \
  > vmstats-$(date +%F-%H%M).dump
```

`-Fc` (formato custom) en vez de SQL plano: comprime, permite restaurar tablas
sueltas y es más rápido de cargar.

Sólo el esquema y la configuración, sin las métricas — mucho más chico y es lo
que de verdad no se puede regenerar:

```sh
docker compose exec -T postgres pg_dump -U vmstats -d vmstats -Fc \
  --exclude-table-data='*_metric_samples' \
  --exclude-table-data='live_snapshots' \
  > vmstats-config-$(date +%F).dump
```

### Backup automático

En el host, un cron diario que conserva 14 días:

```sh
# /etc/cron.d/vmstats-backup
0 3 * * * root cd /ruta/al/proyecto && \
  docker compose exec -T postgres pg_dump -U vmstats -d vmstats -Fc \
    > /var/backups/vmstats-$(date +\%F).dump && \
  find /var/backups -name 'vmstats-*.dump' -mtime +14 -delete
```

Coolify también puede programar backups del volumen; usá uno u otro, no los dos.

### Restore

```sh
# 1. Parar lo que escribe (la base sigue arriba)
docker compose stop web collector

# 2. Restaurar. --clean borra los objetos existentes antes de recrearlos.
cat vmstats-2026-08-14.dump | \
  docker compose exec -T postgres pg_restore -U vmstats -d vmstats --clean --if-exists

# 3. Levantar de nuevo
docker compose start web collector
```

**Verificá antes de dar por buena la restauración:**

```sh
docker compose exec -T postgres psql -U vmstats -d vmstats -c \
  "SELECT count(*) FROM users; SELECT count(*) FROM alert_rules; \
   SELECT max(ts) FROM host_metric_samples;"
```

Si la restauración es sobre una base vacía, corré las migraciones primero:

```sh
docker compose run --rm web node packages/db/dist/migrate.js
```

### Probá el restore

Un backup que nunca se restauró no es un backup. Una vez por trimestre,
restaurá el último volcado en una base descartable y comprobá que la consola
levanta contra ella.

---

## Retención y espacio

Ajustable desde **Preferencias** en la consola.

| Resolución | Por defecto | Aproximado por día y host |
| --- | --- | --- |
| Cruda (10 s) | 7 días | ~30 MB |
| 1 minuto | 30 días | ~5 MB |
| 5 minutos | 365 días | ~1 MB |

Con los valores por defecto, una VM con veinte contenedores ronda **1–2 GB** en
régimen. El collector aplica la retención una vez por hora, en tandas acotadas
para no tomar locks largos.

Bajar un valor borra datos en la próxima pasada y **no se puede deshacer**.

Ver el tamaño real:

```sh
docker compose exec -T postgres psql -U vmstats -d vmstats -c "
  SELECT relname AS tabla, pg_size_pretty(pg_total_relation_size(relid)) AS tamanio
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC LIMIT 8;"
```

---

## Diagnóstico

### La consola dice «Datos desactualizados»

El collector dejó de reportar. Por orden:

```sh
docker compose ps collector          # ¿está corriendo? ¿healthy?
docker compose logs --tail=50 collector
docker compose exec -T postgres psql -U vmstats -d vmstats -c \
  "SELECT host_id, last_seen, now() - last_seen AS silencio FROM collector_heartbeats;"
```

### No aparecen contenedores

```sh
# ¿El collector llega al proxy?
docker compose logs collector | grep -i docker

# ¿El proxy llega al socket?
docker compose logs socket-proxy | tail
```

La causa más común es que `/var/run/docker.sock` no esté montado en el host, o
que el proxy no tenga `CONTAINERS=1`.

### Los filesystems o las interfaces se ven raros

Si aparecen montajes que parecen del contenedor (`/etc/hosts`, `/dev/shm`) en
vez de los del host, es porque `/proc` no está montado o el collector no puede
leer `/proc/1/`. Comprobá los volúmenes del servicio `collector` en el compose.

### La sección Despliegues está vacía

Faltan `COOLIFY_BASE_URL` y `COOLIFY_API_TOKEN`, o el token no tiene `read`. El
collector loguea el fallo y reintenta con backoff; no se cae.

```sh
docker compose logs collector | grep -i coolify
```

### El historial cambió de host

Si la consola muestra una máquina «nueva» sin pasado, el identificador del host
cambió. Ocurre si la VM se reconstruyó. Fijalo con `VMSTATS_HOST_ID` para
conservar las series anteriores.

```sh
docker compose exec -T postgres psql -U vmstats -d vmstats -c \
  "SELECT id, hostname, first_seen, last_seen FROM hosts ORDER BY last_seen DESC;"
```

### Los logs de contenedor no se pueden ver

Tres causas, en este orden:

1. La preferencia está apagada (viene así por defecto) → **Preferencias**.
2. Falta `COLLECTOR_TOKEN_INTERNO` → la UI lo dice explícitamente.
3. El collector no responde → `docker compose logs collector`.

---

## Actualizar

```sh
git pull
docker compose up -d --build
```

Las migraciones se aplican solas al arrancar web. Si una migración falla, el
contenedor no levanta y el log dice por qué — preferible a atender contra un
esquema a medias.

Volver atrás: `git checkout <tag-anterior> && docker compose up -d --build`.
Las migraciones de Drizzle no se revierten solas; si una versión nueva cambió el
esquema de forma incompatible, hay que restaurar el backup previo.

---

## Comandos útiles

```sh
# Estado y salud
docker compose ps

# Seguir el collector
docker compose logs -f collector

# Consola SQL
docker compose exec -it postgres psql -U vmstats -d vmstats

# Reiniciar sólo el collector (no interrumpe la consola)
docker compose restart collector

# Ver la última muestra
docker compose exec -T postgres psql -U vmstats -d vmstats -c \
  "SELECT ts, round(cpu_total::numeric,1) AS cpu, pg_size_pretty(mem_used) AS memoria
   FROM host_metric_samples WHERE resolution='raw' ORDER BY ts DESC LIMIT 5;"

# Auditoría reciente
docker compose exec -T postgres psql -U vmstats -d vmstats -c \
  "SELECT at, action, user_email, ip FROM audit_log ORDER BY at DESC LIMIT 20;"
```
