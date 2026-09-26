# Arquitectura

## El mapa en una frase

Dos procesos y una base: el **collector** mide y escribe, el **web** lee y
muestra, y **PostgreSQL** es el único canal entre los dos.

```
                    ┌───────────────┐
   /proc, /sys ────▶│               │
   (sólo lectura)   │   collector   │──── escribe ───┐
                    │               │                │
   Docker ─────────▶│  (sin puertos │                ▼
   (vía proxy RO)   │   públicos)   │       ┌─────────────────┐
                    │               │       │   PostgreSQL    │
   Coolify API ────▶│               │       │                 │
   (token read)     └───────┬───────┘       │  + LISTEN/NOTIFY│
                            │               └────────┬────────┘
                            │ logs bajo demanda      │
                            │ (API interna, token)   │ lee + escucha
                            ▼                        ▼
                    ┌───────────────────────────────────────┐
                    │                 web                   │
                    │   Astro SSR · React · REST · SSE      │
                    └───────────────────┬───────────────────┘
                                        │ SSE
                                        ▼
                                    navegador
```

## Por qué PostgreSQL es el bus

El collector no expone una API de métricas y el web no consulta al collector.
El collector escribe la muestra y hace `pg_notify`; el web mantiene **una** sola
conexión en `LISTEN` y abanica a todos los navegadores por SSE.

Eso compra tres cosas:

- **El collector no necesita puertos.** Nada de lo que produce viaja por HTTP.
- **Los datos sobreviven al reinicio de cualquiera de los dos.** El estado vive
  en la base, no en la memoria de un proceso.
- **Con veinte pestañas abiertas sigue habiendo una sola conexión escuchando**,
  no veinte consultas periódicas.

La única excepción son los **logs de contenedor**: se piden bajo demanda y no
tendría sentido guardarlos. Para eso el collector expone una API interna con un
solo endpoint de lectura, sin publicar el puerto al host y con token compartido.
Es lo que permite que el contenedor web nunca tenga acceso a Docker. Ver
[security.md](./security.md).

## Los paquetes

| Paquete | Qué contiene |
| --- | --- |
| `packages/shared` | Contratos Zod de todas las fronteras, formateo, redacción de secretos, y la lógica **pura**: máquina de estados de alertas, planificador de resolución. Sin dependencias de I/O. |
| `packages/db` | Esquema Drizzle, migraciones, preferencias, motor de alertas y hashing de contraseñas. Compila a JavaScript plano, así los CLIs (`migrate`, `bootstrap`) corren en la imagen de producción. |
| `apps/collector` | Lectura de `/proc`, Docker, Coolify. Rollups y retención. |
| `apps/web` | Astro SSR, islas de React, REST, SSE, sesiones. |

La lógica que se puede probar sin I/O está deliberadamente separada de la que
toca el sistema. Los parsers de `/proc` reciben el **contenido** del archivo, no
la ruta: por eso se testean con fixtures reales de un host Linux desde cualquier
sistema operativo.

## El esquema: una columna en vez de tres tablas

La decisión central del modelo de datos. En vez de `host_metric_samples`,
`host_metric_samples_5m` y `host_metric_samples_15m`, hay **una** tabla con una
columna `resolution` dentro de la clave primaria:

```
PRIMARY KEY (host_id, resolution, ts)
```

Con eso:

- el rollup es un `INSERT … SELECT … GROUP BY date_bin` sobre la misma tabla,
- la retención es un `DELETE WHERE resolution = $1 AND ts < $2`,
- el historial cambia de granularidad sin cambiar de tabla.

Tres tablas paralelas habrían triplicado el mismo SQL con distinto nombre.

### Agregación y retención

Retención progresiva y fija (`RETENCION_HORAS` en `packages/shared/src/tiempo.ts`):

| Resolución | Intervalo | Se guarda | La lee |
| --- | --- | --- | --- |
| `raw` | 10 s host · 30 s contenedores · 60 s filesystems | 26 horas | rangos de 15 min a 24 h |
| `5m` | 5 minutos | 3 días | rangos viejos de más de 26 h y menos de 3 días |
| `15m` | 15 minutos | 7 días | el rango de 7 días |

Nada se guarda más de siete días. Las resoluciones se solapan —el agregado de 15
minutos también cubre las últimas horas— porque cada consulta lee de una sola
fuente; el volumen lo ponen los crudos, así que solaparse cuesta poco. `15m` y
no `30m` en el tramo largo porque el gráfico de 7 días pide buckets de 900 s.

La retención corre dentro del collector una vez por hora (y en la vuelta
siguiente si quedó atraso), en tandas de 10.000 filas por `ctid` con una pausa
entre tandas, así la ingesta nunca espera un lock largo. También borra
cualquier resolución que ya no exista en el esquema.

Los rollups corren cada 5 minutos y **recalculan una ventana móvil reciente**
(1 h de crudos, 3 h de agregados de 5 min) en vez de llevar una marca de agua, y
al arrancar el collector una ventana larga (24 h y 7 días) que repara lo que
haya quedado sin agregar. Usan `ON CONFLICT DO UPDATE … WHERE EXCLUDED.sample_count
> actual`: un bucket sólo se reescribe si ahora resume más muestras. Recalcular
un bucket cerrado da lo mismo, y reescribirlo igual cada minuto era lo que
llenaba las tablas de tuplas muertas.

Sólo se agregan buckets **ya cerrados**. Un bucket del intervalo en curso está
incompleto; se agrega en la corrida siguiente.

**Qué se pierde al agregar:** los gauges y las tasas se promedian, los
contadores de errores se suman, lo monótono (uptime, reinicios, memoria total)
va con `max` y el filesystem se queda con el último valor del bucket. Un pico de
un minuto se diluye en el promedio de cinco. Por eso las últimas 24 horas se
guardan con resolución completa: es donde se mira un incidente reciente.

### Cuántos puntos devuelve una consulta

El navegador pide un **rango**, no una granularidad. `planificarConsulta`
(en `packages/shared/src/tiempo.ts`) elige de qué resolución leer y con qué ancho
de bucket, con dos restricciones a la vez:

1. entre 300 y 800 puntos por serie,
2. la resolución de origen tiene que existir todavía para ese rango.

Pedir 7 días nunca manda 60.000 filas al navegador. Si hubo que degradar la
granularidad por retención, la respuesta lo dice y la UI lo muestra en vez de
mentir.

Los huecos se conservan: la grilla sale de `generate_series` y los datos entran
por `LEFT JOIN`, así que un período sin muestras produce `null` y el gráfico
dibuja una interrupción. Un `GROUP BY` a secas saltearía esos buckets y la línea
uniría los extremos, dando a entender que el sistema estuvo funcionando.

## Tiempo real

```
collector ──▶ live_snapshots (upsert)  ──▶ pg_notify('vmstats_instantanea')
                                                      │
                                            web (1 conexión LISTEN)
                                                      │
                                        SSE ─────▶ navegadores
```

El `NOTIFY` lleva sólo el `hostId`: el límite del canal son 8000 bytes y una
instantánea con contenedores lo pasa cómodamente. El web lee la fila y empuja.

Del lado del navegador (`hooks/useFlujo.ts`):

- reconexión con **backoff exponencial** propio, porque el de `EventSource` es
  fijo y machaca cada 3 segundos contra un servidor caído;
- **reanudación** por `?desde=<id>`: `EventSource` no permite mandar cabeceras,
  así que `Last-Event-ID` no sirve desde el cliente;
- **pausa con la pestaña oculta**, para que diez pestañas de fondo no sostengan
  diez conexiones;
- **fallback a polling** cada 15 s si el stream no logra establecerse.

## Alertas: dónde vive cada parte

- La **máquina de estados** (duración mínima, cooldown, histéresis, silencio)
  es pura y vive en `packages/shared`. Recibe el reloj por parámetro, así que se
  testean horas de comportamiento sin esperar.
- El **motor** que la aplica contra la base vive en `packages/db`.
- El **collector** evalúa todas las reglas… salvo una.

`collector.silencioSegundos` mide cuánto hace que el collector no reporta, y el
collector siempre está vivo cuando la evalúa: la regla nunca dispararía. La
evalúa el **proceso web**, que es el que sigue en pie cuando el collector se
cae. Es la contraparte del banner de «Datos desactualizados»: el banner avisa a
quien está mirando la pantalla, la alerta queda registrada aunque no haya nadie.

## Idempotencia

Tres mecanismos, todos apoyados en la base y no en que el código recuerde algo:

| Qué | Cómo |
| --- | --- |
| Muestras duplicadas | `ON CONFLICT DO NOTHING` sobre la PK `(host, resolución, ts)`. |
| Eventos de despliegue repetidos tras reiniciar | Índice único `(deployment_uuid, status)`: cada par se guarda una sola vez, para siempre. |
| Dos rollups en paralelo | `pg_try_advisory_lock`, que no espera: si otro proceso lo tiene, se saltea el tick. |

## Lecciones que quedaron en el código

Cosas que sólo aparecieron al ejecutar de verdad, y que están comentadas donde
importan:

- **`/proc/mounts` y `/proc/net` son relativos al namespace.** Leerlos desde un
  contenedor devuelve los montajes y las interfaces *del contenedor*, aunque se
  haya montado el `/proc` del host. Hay que leer `/proc/1/…`.
- **`Intl` no coincide entre Node y el navegador.** Para `es-AR`, Node emite
  U+00A0 antes de «a. m.» donde Chrome emite U+202F. Los textos se ven idénticos
  y React descarta la hidratación entera. Todo el formateo normaliza espacios.
- **`'unsafe-inline'` en `style-src` queda anulado si hay un hash en la lista.**
  Astro agrega hashes, así que los `style={{…}}` de React quedaban bloqueados en
  silencio.
- **La API de Docker devuelve `null`, no colecciones vacías**, en `Ports`,
  `Names` y `Labels`.
- **PostgreSQL rechaza un decimal en una columna `bigint`.** El redondeo va en
  la frontera de persistencia, no en cada fuente.
