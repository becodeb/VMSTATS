# vmstats

Consola de observabilidad para una VM: métricas del host, contenedores Docker y
despliegues de Coolify. Todo corre en tu propia máquina — no hay servicios
externos obligatorios ni telemetría hacia terceros.

![Estado](https://img.shields.io/badge/estado-funcional-informational)

---

## Qué hace

- **Host**: CPU total y por núcleo (user, system, iowait, steal), load average,
  memoria y swap, uptime, filesystems con inodos, I/O de disco con latencia, red
  por interfaz, conexiones TCP, top de procesos, presión PSI y temperatura donde
  el kernel la exponga.
- **Contenedores**: estado, healthcheck, CPU, memoria contra su límite, red,
  block I/O, uptime, reinicios, puertos, y a qué aplicación de Coolify
  pertenecen. Inspector lateral con logs bajo demanda y redacción de secretos.
- **Despliegues**: activos, cola, timeline de transiciones, duraciones, fallos,
  commit y rama. Franja persistente bajo la barra mientras algo se despliega.
- **Alertas**: reglas con umbral, duración mínima, cooldown e histéresis.
  Reconocer y silenciar. Sin notificaciones externas.
- **Historial**: rango arbitrario, comparación contra el período anterior,
  despliegues superpuestos en los gráficos y exportación CSV.
- **API**: todo lo anterior es consultable con una clave de API por cabecera
  `Authorization: Bearer`, con alcance de sólo lectura por defecto. Se
  administran desde Preferencias o por línea de comandos.

Lo que **no** hace: actuar sobre contenedores (reiniciar, parar, exec), mandar
notificaciones a ningún lado, ni depender de Prometheus o Grafana.

## Stack

Astro 7 en modo servidor con el adaptador de Node · React 19 para las islas
interactivas · TypeScript estricto · Tailwind CSS 4 · Recharts · Drizzle ORM
sobre PostgreSQL 17 · Zod en todas las fronteras · SSE para tiempo real ·
Vitest y Playwright.

---

## Desarrollo

Requisitos: Node ≥ 22.12 y Docker.

```sh
npm install

# PostgreSQL para desarrollo
docker run -d --name vmstats-pg -p 55432:5432 \
  -e POSTGRES_USER=vmstats -e POSTGRES_PASSWORD=vmstats -e POSTGRES_DB=vmstats \
  postgres:17-alpine

export DATABASE_URL="postgresql://vmstats:vmstats@localhost:55432/vmstats"
export SESSION_SECRET="un-secreto-local-de-al-menos-32-caracteres"

npm run build                      # compila los paquetes compartidos
npm run db:migrate                 # aplica migraciones y siembra la configuración
npm run bootstrap:admin            # crea el primer usuario
```

Después, en dos terminales:

```sh
npm run dev             # la consola en http://localhost:4321
npm run dev:collector   # el collector
```

En Windows o macOS no hay `/proc`, así que el collector no puede medir la
máquina real. Para eso está el modo demo, con series sintéticas y un aviso bien
visible en el log:

```sh
VMSTATS_DEMO=1 npm run dev:collector
```

### Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run verificar` | lint + typecheck + tests + build. Es el gate completo. |
| `npm run lint` | oxlint, sin tolerar warnings |
| `npm run typecheck` | `tsc -b` de los paquetes + `astro check` de la web |
| `npm test` | unitarios; los de integración corren solos si hay `DATABASE_URL` |
| `npm run build` | build de producción |
| `node scripts/e2e.mjs` | levanta el compose y corre los end-to-end |
| `npm run db:generate` | genera una migración tras cambiar el esquema |

### Tests

Los **unitarios** no tocan nada externo: parsers de `/proc` contra fixtures
reales, máquina de alertas con reloj falso, redacción de secretos, planificador
de resolución. Corren en cualquier sistema operativo.

Los de **integración** necesitan PostgreSQL y se saltean solos sin
`DATABASE_URL` — un `npm test` en una máquina sin base dice «no probé esto», no
«está roto».

Los **end-to-end** corren en Chromium contra el despliegue real y verifican dos
cosas que ninguna otra comprobación detecta: que las islas de React hidraten
(un CSP mal armado deja la consola muerta pero con buena pinta) y que no haya
scroll horizontal en 360, 768, 1280 y 1920 px.

---

## Despliegue

Paso a paso en **[docs/operations.md](docs/operations.md)**. En resumen:

```sh
cp .env.example .env    # completar POSTGRES_PASSWORD y SESSION_SECRET
docker compose up -d --build
docker compose exec -it web node packages/db/dist/bootstrap.js
```

Cuatro servicios: `postgres`, `socket-proxy`, `collector` y `web`. Sólo `web`
publica un puerto.

> **Leé [docs/security.md](docs/security.md) antes de desplegar.** Montar
> `/var/run/docker.sock` es una operación privilegiada: quien pueda escribir en
> ese socket controla la máquina. vmstats lo acota con un proxy de sólo lectura
> con las escrituras prohibidas, y el contenedor web no tiene ninguna ruta hacia
> Docker.

---

## Documentación

| Documento | Contenido |
| --- | --- |
| [architecture.md](docs/architecture.md) | Cómo se conectan las piezas, el modelo de datos, los rollups, el tiempo real |
| [security.md](docs/security.md) | Aislamiento de Docker, autenticación, CSP, manejo de datos sensibles |
| [operations.md](docs/operations.md) | Despliegue en Coolify, backup y restore, retención, diagnóstico |
| [lint.md](docs/lint.md) | Qué reglas están desactivadas y por qué |

---

## Decisiones que conviene conocer

**PostgreSQL es el único canal entre el collector y la web.** El collector
escribe y hace `NOTIFY`; la web escucha con una sola conexión y abanica por SSE.
Así el collector no expone puertos y el estado sobrevive al reinicio de
cualquiera de los dos.

**Una tabla por familia de métricas, con la resolución en la clave primaria.**
El rollup es un `INSERT … SELECT` sobre la misma tabla y la retención un
`DELETE`. Tres tablas paralelas habrían triplicado el mismo SQL.

**El servidor elige la resolución.** El navegador pide un rango; el planificador
devuelve entre 300 y 800 puntos por serie. Pedir 30 días nunca manda 260.000
filas.

**«Sin datos» es un estado de primera clase.** Si el collector dejó de reportar,
la consola no dice «saludable»: dice que no sabe. Lo que el host no puede medir
—PSI en un kernel viejo, temperatura en una VM— se muestra como «no disponible»,
nunca como cero.

**Autenticación propia y no una librería.** Better Auth guarda el token de sesión
en claro; acá se guarda su SHA-256. El razonamiento completo está en
[security.md](docs/security.md).

**La página nunca scrollea horizontalmente.** En móvil las tablas se convierten
en tarjetas expandibles, no en un `overflow-x: auto` que esconde datos detrás de
un gesto que compite con el scroll de la página.
