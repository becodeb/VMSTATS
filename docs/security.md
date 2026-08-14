# Seguridad

## Lo que hay que saber antes de desplegar

**Montar `/var/run/docker.sock` es una operación privilegiada.** Quien pueda
escribir en ese socket controla la máquina entera: puede levantar un contenedor
privilegiado con el disco del host montado y salir del aislamiento. No es un
detalle de configuración, es la decisión de seguridad más importante de este
despliegue.

vmstats la acota así:

- El socket lo ve **únicamente** `socket-proxy`, y en modo lectura.
- El proxy tiene `POST=0`: **ninguna** operación de escritura pasa, ni siquiera
  si el collector la intentara.
- El collector habla con el proxy por HTTP y su cliente **sólo sabe hacer GET**.
  No existe en el código un camino que cree, borre, reinicie o ejecute nada.
- El contenedor **web no está en la red del proxy**. No puede llegar a Docker
  aunque quisiera.

### Verificado, no asumido

```
$ docker compose exec collector <probar el proxy>
GET  /containers/json      -> 200
POST /containers/create    -> 403
POST /containers/x/restart -> 403
DELETE /containers/x       -> 403
GET  /images/json          -> 403

$ docker compose exec web <probar el acceso a Docker>
socket-proxy:2375          -> ENOTFOUND
collector:8787 (sin token) -> 401
/var/run/docker.sock       -> No such file or directory
```

### Si preferís el socket directo

Es más simple y **menos seguro**: el collector pasa a tener acceso completo al
socket, y la única barrera es que su cliente no implemente escrituras. Se
configura con `DOCKER_SOCKET=/var/run/docker.sock` en lugar de
`DOCKER_PROXY_HOST`, montando el socket en el collector como `:ro`. La
recomendación es no hacerlo.

## Autenticación

### Por qué está escrita a mano

Se evaluó **Better Auth**, que es la solución mantenida y compatible con Astro,
PostgreSQL y Drizzle. Se descartó por un requisito concreto: guarda el token de
sesión **en claro** en la columna `token` de su tabla `session` (verificado en
sus propios snapshots de esquema). La spec exige que los tokens se guarden
hasheados.

El resto de los requisitos —Argon2id, rotación, CSRF, rate limiting por IP y por
cuenta— también son específicos, y el módulo resultante son unas 250 líneas
sobre el patrón clásico de Lucia.

### Cómo funciona

| Aspecto | Implementación |
| --- | --- |
| Contraseñas | Argon2id vía `@node-rs/argon2`. 19 MiB, 2 pasadas, paralelismo 1 (línea base de OWASP). |
| Token de sesión | 32 bytes aleatorios en base64url. Vive **sólo** en la cookie. |
| En la base | SHA-256 del token. Un dump de la base no da sesiones usables. |
| Duración | 30 días, con **rotación** a mitad de vida: token nuevo, fila nueva, la vieja se borra. Un token robado deja de servir. |
| Cookie de sesión | `HttpOnly`, `Secure` en producción, `SameSite=Lax`. |
| CSRF | Double-submit **firmado**: el token es un HMAC del id de sesión con `SESSION_SECRET`. Aunque alguien plante una cookie desde un subdominio, no puede fabricar uno válido. |
| Verificación CSRF | En el middleware, no en cada endpoint — para que no se pueda olvidar en uno. Sólo vale la **cabecera**; aceptar la cookie anularía la protección. |
| Origen | Se valida `Origin` en toda mutación, como segunda barrera independiente. |
| Rate limiting | 20 intentos por IP y 8 por cuenta cada 15 minutos. Las dos dimensiones: ni una IP prueba mil usuarios, ni mil IPs un solo usuario. |

`SameSite=Lax` y no `Strict` a propósito: con `Strict`, quien llega desde un
link externo aparece deslogueado aunque tenga sesión. `Lax` no manda la cookie
en peticiones cruzadas que muten, que es la protección que importa.

### Enumeración de cuentas

El login responde lo mismo para «no existe», «contraseña incorrecta» y «cuenta
deshabilitada». Además **verifica un hash de descarte** cuando el usuario no
existe: sin eso, un email inexistente responde en 1 ms y uno real en 50, y esa
diferencia permite enumerar cuentas.

### El primer usuario

vmstats **no crea credenciales por defecto**. Una instalación recién desplegada
no tiene con qué entrar hasta que alguien corra:

```sh
docker compose exec -it web node packages/db/dist/bootstrap.js
```

Es a propósito: una consola con todas las métricas de la VM detrás de
`admin/admin` es peor que no tener consola. La pantalla de login lo explica
cuando no hay usuarios.

Alternativa no interactiva con `VMSTATS_ADMIN_EMAIL` y `VMSTATS_ADMIN_PASSWORD`,
**de un solo uso**: el script avisa que hay que borrarlas del entorno después.

### Claves de API

Para hablarle a la consola desde un script o un cron hay un segundo mecanismo,
por cabecera `Authorization: Bearer vmst_…`.

Comparte el modelo criptográfico de las sesiones: **la base guarda el SHA-256 del
secreto, nunca el secreto.** Se muestra una única vez, cuando se crea; después no
hay forma de recuperarlo ni con acceso a la base. La columna `prefix` guarda los
primeros ocho caracteres en claro, que sirven para reconocer la clave en la lista
—y para identificar una filtrada en un log ajeno— sin alcanzar para autenticar.

Cuatro decisiones que conviene conocer:

- **Sólo sirven en `/api/`.** Una clave no abre el dashboard. Aceptar un Bearer
  para renderizar HTML agregaría superficie sin resolver ningún caso de uso.
- **Tienen alcance, y el valor por defecto es `read`** (sólo `GET` y `HEAD`). Para
  mutar hace falta `admin`, elegido a propósito. Se verifica en el middleware, no
  en cada endpoint, por la misma razón que el CSRF: para que no se pueda olvidar
  en uno.
- **Una clave no puede crear otra clave.** Emitir y revocar exige una sesión de
  navegador. Sin esa regla, `admin` sería en la práctica permanente e
  irrevocable: quien se hiciera con una podría emitirse otras sin límite, y
  revocar la original no serviría de nada.
- **No llevan CSRF, y no es una excepción incómoda.** El CSRF protege contra que
  el *navegador* adjunte sola la credencial en un pedido de otro sitio; una
  cabecera `Authorization` no se adjunta sola nunca. Hay que escribirla, y para
  escribirla hay que tener el secreto.

Dar de baja a un usuario corta también sus claves: sin eso, revocar a una persona
dejaría sus scripts andando. Igual que con las sesiones, una clave inexistente,
revocada, vencida o de un usuario deshabilitado son indistinguibles desde afuera.

Se administran desde **Preferencias** en la consola, o sin navegador:

```sh
docker compose exec web node /app/packages/db/dist/clave.js crear \
  --email vos@ejemplo.com --nombre "cron de backups" --alcance read --dias 90

docker compose exec web node /app/packages/db/dist/clave.js listar  --email vos@ejemplo.com
docker compose exec web node /app/packages/db/dist/clave.js revocar --email vos@ejemplo.com --id <id>
```

Ejemplo de uso:

```sh
curl -H "Authorization: Bearer vmst_…" https://tu-consola/api/instantanea
```

El token **no se acepta por query string**. Iría a parar a los logs de acceso del
proxy, al historial del navegador y al `Referer`.

## Cabeceras

| Cabecera | Valor |
| --- | --- |
| `Content-Security-Policy` | La emite **Astro** con los hashes de sus scripts de hidratación; el middleware le suma `frame-ancestors 'none'` y `style-src-attr`. |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `same-origin` |
| `Permissions-Policy` | cámara, micrófono, geolocalización y FLoC deshabilitados |
| `Strict-Transport-Security` | 1 año, sólo en producción |

### Por qué el CSP lo emite Astro

Una política escrita a mano bloquea los scripts inline con los que Astro hidrata
las islas de React: la consola carga entera y con buena pinta, pero **ningún
control responde**. Se detectó con el test en navegador; un `curl` no lo ve.

Dos concesiones acotadas, ambas documentadas donde están:

- `style-src` acepta `'unsafe-inline'` porque Recharts escribe posiciones como
  estilos inline en el SVG. `script-src` **no** lo tiene.
- `style-src-attr 'unsafe-inline'` va como directiva propia en la cabecera:
  `'unsafe-inline'` dentro de `style-src` queda anulado en cuanto hay un hash en
  la lista, y sin esta directiva el navegador bloqueaba todos los `style={{…}}`
  de React. Un atributo de estilo no puede cargar recursos ni ejecutar código:
  el riesgo que abre es cosmético.

## Datos sensibles

### Logs de contenedor

Doble compuerta antes de llegar a Docker:

1. La preferencia `logsHabilitados`, **apagada por defecto**.
2. La API interna del collector, que exige el token compartido.

Y tres reglas más:

- **No se guardan.** Se piden, se muestran y se olvidan. No hay tabla de logs.
- **Tienen tope** de líneas y de bytes, aplicados en Docker (`tail`) y en el
  cliente HTTP (corta la conexión), así que ninguno depende de que el contenedor
  se porte bien.
- **Pasan por el redactor** antes de salir del collector.

El redactor (`packages/shared/src/redaccion.ts`) tapa: contraseñas en
`clave=valor`, credenciales embebidas en URLs, cabeceras `Authorization`, JWTs,
claves con prefijo reconocible (`sk-`, `ghp_`, `xoxb-`, `AKIA…`) y bloques PEM.
El criterio es pecar de prudente. Lo que se tapa **se cuenta y se informa en la
UI**, para que nadie crea que está viendo el log crudo.

En el navegador se renderizan como texto. Nunca con `dangerouslySetInnerHTML` —
ni ahí ni en ningún otro lugar del proyecto. Los escapes ANSI y los caracteres
de control se quitan: un `\r` bien puesto permite tapar la línea anterior, así
que quien pueda escribir en el log de un contenedor podría dibujar una consola
falsa.

### Procesos

El top de procesos muestra **sólo el nombre del comando, sin argumentos**. Los
argumentos filtran tokens y contraseñas con demasiada facilidad
(`node server.js --api-key=…`).

### Token de Coolify

Vive **sólo** en el proceso collector, que no expone puertos. Nunca viaja al
navegador: la UI ve despliegues ya normalizados que salieron de la base.

Usá un token con permiso **`read`**. `read:sensitive` hace que la API devuelva
secretos de las aplicaciones en claro, y vmstats no lo necesita. Los logs de
build de Coolify sí lo requieren, y por eso esa función viene deshabilitada y la
UI lo explica en vez de mostrar un botón que falla.

### Errores

El cliente recibe un código estable y una frase para humanos, nunca el mensaje
de la excepción: un error de Postgres puede llevar nombres de tablas y uno de
Coolify parte del token. El detalle va al log del servidor.

## Contenedores

| Medida | web | collector | postgres |
| --- | --- | --- | --- |
| `cap_drop: ALL` | ✔ | ✔ | — |
| `no-new-privileges` | ✔ | ✔ | ✔ |
| `read_only: true` | ✔ | ✔ | — (necesita escribir sus datos) |
| Usuario no root | ✔ (`node`) | ✔ (`node`) | ✔ (`postgres`) |
| Puerto publicado | sólo el de la consola | ninguno | ninguno |

`privileged: true` **no se usa**. Leer `/proc` y `/sys` montados como sólo
lectura alcanza para todo lo que mide vmstats.

Postgres no publica puerto: sólo es alcanzable desde la red interna. Para un
backup se usa `docker compose exec` (ver [operations.md](./operations.md)).

## Auditoría

Se registran en `audit_log`: entrar, salir, intentos fallidos, bloqueos por rate
limit, cambios de reglas de alerta, silenciamientos, reconocimientos, cambios de
preferencias y la creación y revocación de claves de API. Con usuario, email, IP
y detalle.

De una clave se anota el nombre, el alcance y el vencimiento. El secreto no, ni
siquiera ahí.

No se audita la navegación: un registro que anota cada vista abierta se vuelve
ruido y esconde los eventos que importan.

## Lo que vmstats no hace

- **No manda notificaciones a ningún lado.** No hay integración de salida en el
  código.
- **No ejecuta acciones sobre contenedores.** Ni reiniciar, ni parar, ni exec.
- **No envía telemetría.** `connect-src 'self'` lo impide incluso ante una
  inyección.
- **No indexa.** `robots: noindex, nofollow`.
