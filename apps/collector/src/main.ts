import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Despliegue, InstanciaAlerta, MuestraContenedor, MuestraHost } from '@vmstats/shared'
import { baseDesdeUrl, conLock, evaluarCiclo, leerPreferencias } from '@vmstats/db'
import { cargarConfiguracion, describir, type Configuracion } from './config.js'
import { ClienteDocker } from './docker/cliente.js'
import { traerLogs } from './docker/logs.js'
import { crearServidorInterno } from './servidor-interno.js'
import { FuenteDocker } from './docker/fuente.js'
import { ClienteCoolify, normalizarDespliegue } from './coolify/cliente.js'
import {
  diferenciarDespliegues,
  proximoIntervalo,
  resolverDesaparecido,
  type Transicion,
} from './coolify/seguimiento.js'
import { FuenteContenedoresDemo, FuenteDemo } from './fuentes/demo.js'
import { FuenteProcfs } from './fuentes/procfs.js'
import type { FuenteContenedores, FuenteHost } from './fuentes/tipos.js'
import {
  guardarContenedores,
  guardarMuestraHost,
  guardarTransiciones,
  publicarInstantanea,
  registrarHost,
  registrarLatido,
} from './persistencia.js'
import { correrRetencion } from './trabajos/retencion.js'
import { correrTodosLosRollups } from './trabajos/rollup.js'
import type { EstadoDespliegue } from '@vmstats/shared'

/* ============================================================================
 * Proceso collector.
 *
 * Cuatro relojes independientes:
 *   - muestreo      cada 5 s   → memoria
 *   - persistencia  cada 10 s  → base + NOTIFY + evaluación de alertas
 *   - Coolify       5 s / 30 s → adaptativo, con backoff
 *   - mantenimiento cada 60 s  → rollups; cada hora, retención
 *
 * Todas las métricas salen por PostgreSQL: el collector escribe y hace NOTIFY,
 * y web lee. No hay ningún puerto involucrado en ese camino.
 *
 * La única excepción son los logs de contenedor, que se piden bajo demanda y no
 * tendría sentido guardar en la base. Para eso hay una API interna con un solo
 * endpoint de lectura, sin publicar al host y con token compartido — ver
 * `servidor-interno.ts`. Es lo que permite que el contenedor web nunca tenga
 * acceso a Docker.
 * ========================================================================== */

const ARCHIVO_VIDA = join(tmpdir(), 'vmstats-collector-vivo')

function registrar(nivel: 'info' | 'aviso' | 'error', mensaje: string, extra?: unknown): void {
  const linea = `[collector] ${new Date().toISOString()} ${nivel} ${mensaje}`
  if (nivel === 'error') console.error(linea, extra ?? '')
  else console.log(linea, extra ?? '')
}

/**
 * Bucle periódico que no acumula deriva ni se solapa consigo mismo.
 *
 * `setInterval` con un trabajo asíncrono más lento que el intervalo encola
 * ejecuciones hasta ahogarse. Acá cada vuelta se agenda recién cuando terminó
 * la anterior, así que un ciclo lento retrasa el siguiente en vez de duplicarlo.
 */
function cadaTanto(
  intervaloMs: number | (() => number),
  trabajo: () => Promise<void>,
  alFallar: (error: unknown) => void,
): () => void {
  let vivo = true
  let temporizador: NodeJS.Timeout | null = null

  const vuelta = async (): Promise<void> => {
    if (!vivo) return
    try {
      await trabajo()
    } catch (error) {
      alFallar(error)
    }
    if (!vivo) return
    const espera = typeof intervaloMs === 'function' ? intervaloMs() : intervaloMs
    temporizador = setTimeout(() => void vuelta(), espera)
  }

  temporizador = setTimeout(() => void vuelta(), 0)

  return () => {
    vivo = false
    if (temporizador !== null) clearTimeout(temporizador)
  }
}

interface EstadoCollector {
  ultimaMuestra: MuestraHost | null
  contenedores: MuestraContenedor[]
  desplieguesActivos: Despliegue[]
  alertasAbiertas: InstanciaAlerta[]
  conocidos: Map<string, EstadoDespliegue>
  erroresCoolify: number
}

function construirFuentes(config: Configuracion): {
  host: FuenteHost
  contenedores: FuenteContenedores | null
  docker: ClienteDocker | null
} {
  if (config.demo) {
    registrar(
      'aviso',
      'MODO DEMO ACTIVO: los datos son sintéticos y no reflejan esta máquina',
    )
    return { host: new FuenteDemo(), contenedores: new FuenteContenedoresDemo(), docker: null }
  }

  const host = new FuenteProcfs(config.procfs)

  if (config.docker.modo === 'apagado') {
    registrar('aviso', 'Docker no configurado: no habrá métricas de contenedores')
    return { host, contenedores: null, docker: null }
  }

  const docker =
    config.docker.modo === 'socket'
      ? new ClienteDocker({
          socketPath: config.docker.socketPath,
          timeoutMs: config.docker.timeoutMs,
        })
      : new ClienteDocker({
          host: config.docker.host,
          puerto: config.docker.puerto,
          timeoutMs: config.docker.timeoutMs,
        })

  return { host, contenedores: new FuenteDocker(docker, 'pendiente'), docker }
}

async function main(): Promise<void> {
  const config = cargarConfiguracion()
  registrar('info', 'arrancando', describir(config))

  const { pool, db } = baseDesdeUrl({ url: config.urlBase, maxConexiones: 4 })
  const fuentes = construirFuentes(config)

  const estado: EstadoCollector = {
    ultimaMuestra: null,
    contenedores: [],
    desplieguesActivos: [],
    alertasAbiertas: [],
    conocidos: new Map(),
    erroresCoolify: 0,
  }

  if (fuentes.contenedores instanceof FuenteDocker) {
    const accesible = await fuentes.contenedores.comprobarAcceso()
    registrar(
      accesible ? 'info' : 'aviso',
      accesible ? 'Docker accesible (sólo lectura)' : 'Docker inaccesible: sin contenedores',
    )
  }

  const coolify = config.coolify.habilitado
    ? new ClienteCoolify({
        baseUrl: config.coolify.baseUrl,
        token: config.coolify.token,
        timeoutMs: config.coolify.timeoutMs,
      })
    : null

  /* --- Muestreo ------------------------------------------------------- */

  const detenerMuestreo = cadaTanto(
    config.intervaloMuestraMs,
    async () => {
      const muestra = await fuentes.host.muestrear()
      // La primera vuelta sólo deja la base para calcular tasas.
      if (muestra === null) return

      if (fuentes.contenedores instanceof FuenteDocker) {
        fuentes.contenedores.fijarHostId(muestra.hostId)
        fuentes.contenedores.fijarMemoriaHost(muestra.memoria.total)
      }

      const contenedores =
        fuentes.contenedores === null ? [] : await fuentes.contenedores.muestrear()

      muestra.capacidades.contenedores = fuentes.contenedores?.disponible() ?? false
      muestra.capacidades.coolify = coolify !== null

      estado.ultimaMuestra = muestra
      estado.contenedores = contenedores
    },
    (error) => registrar('error', 'falló el muestreo', error),
  )

  /* --- Persistencia --------------------------------------------------- */

  const intervaloSegundos = Math.round(config.intervaloMuestraMs / 1000)

  const detenerPersistencia = cadaTanto(
    config.intervaloPersistenciaMs,
    async () => {
      const muestra = estado.ultimaMuestra
      if (muestra === null) return

      await registrarHost(db, muestra)
      await guardarMuestraHost(db, muestra)
      await guardarContenedores(db, estado.contenedores)
      await registrarLatido(db, muestra, config.version, intervaloSegundos)

      // Las alertas se evalúan acá y no en el muestreo para que la instantánea
      // que sale por SSE lleve ya el resultado del mismo ciclo.
      const evaluacion = await evaluarCiclo(db, {
        host: muestra,
        contenedores: estado.contenedores,
        silencioSegundos: 0,
      })
      estado.alertasAbiertas = evaluacion.abiertas

      await publicarInstantanea(db, {
        host: muestra,
        contenedores: estado.contenedores,
        desplieguesActivos: estado.desplieguesActivos,
        alertasAbiertas: estado.alertasAbiertas,
      })

      // Señal de vida para el healthcheck del contenedor. Un archivo en vez de
      // un puerto: la spec pide que el collector no exponga nada.
      await writeFile(ARCHIVO_VIDA, String(Date.now()), 'utf8')
    },
    (error) => registrar('error', 'falló la persistencia', error),
  )

  /* --- Coolify -------------------------------------------------------- */

  const detenerCoolify =
    coolify === null
      ? () => {}
      : cadaTanto(
          () =>
            proximoIntervalo(estado.desplieguesActivos.length > 0, estado.erroresCoolify),
          async () => {
            try {
              const [crudos, aplicaciones] = await Promise.all([
                coolify.desplieguesActivos(),
                coolify.aplicaciones(),
              ])

              const ramas = new Map(
                aplicaciones.map((a) => [a.uuid, a.git_branch ?? null] as const),
              )
              const activos = crudos.map((c) => normalizarDespliegue(c, ramas))

              const diferencia = diferenciarDespliegues(activos, estado.conocidos)
              const transiciones: Transicion[] = [...diferencia.transiciones]

              // Los que desaparecieron de la lista de activos terminaron: hay
              // que ir a buscar con qué estado, o quedarían «en curso» para
              // siempre.
              for (const uuid of diferencia.aConsultar) {
                const anterior = estado.conocidos.get(uuid) ?? 'unknown'
                const crudo = await coolify.despliegue(uuid)
                const encontrado = crudo === null ? null : normalizarDespliegue(crudo, ramas)
                transiciones.push(resolverDesaparecido(uuid, encontrado, anterior))
                diferencia.conocidos.delete(uuid)
              }

              const guardadas = await guardarTransiciones(db, transiciones)
              if (guardadas > 0) {
                registrar('info', `${guardadas} cambio(s) de estado de despliegue`)
              }

              // El mapa se adopta recién ahora: si la escritura falló, la
              // próxima vuelta vuelve a intentar la misma transición.
              estado.conocidos = diferencia.conocidos
              estado.desplieguesActivos = activos
              estado.erroresCoolify = 0
            } catch (error) {
              estado.erroresCoolify += 1
              registrar(
                'aviso',
                `Coolify no responde (intento ${estado.erroresCoolify}), reintentando con backoff`,
                error instanceof Error ? error.message : error,
              )
            }
          },
          (error) => registrar('error', 'falló el ciclo de Coolify', error),
        )

  /* --- Mantenimiento -------------------------------------------------- */

  let ciclosMantenimiento = 0

  const detenerMantenimiento = cadaTanto(
    60_000,
    async () => {
      ciclosMantenimiento += 1

      await conLock(pool, 'rollup1m', async () => {
        const resultados = await correrTodosLosRollups(db)
        const total = resultados.reduce((suma, r) => suma + r.filasHost, 0)
        if (total > 0) registrar('info', `rollup: ${total} bucket(s) de host`)
      })

      // Retención una vez por hora: borrar más seguido no cambia nada y cada
      // pasada toca las cinco tablas de métricas.
      if (ciclosMantenimiento % 60 === 1) {
        await conLock(pool, 'retencion', async () => {
          const preferencias = await leerPreferencias(db)
          const resumen = await correrRetencion(db, preferencias)
          if (resumen.metricas > 0) {
            registrar('info', `retención: ${resumen.metricas} fila(s) borradas`)
          }
        })
      }
    },
    (error) => registrar('error', 'falló el mantenimiento', error),
  )

  /* --- API interna ------------------------------------------------------ */

  /* Sólo se levanta si hay Docker y token. Sin cualquiera de los dos, el
   * inspector de contenedores muestra los logs como no disponibles, que es
   * mejor que un endpoint abierto o un botón que falla. */
  const servidorInterno =
    config.interno.habilitado && fuentes.docker !== null
      ? crearServidorInterno({
          puerto: config.interno.puerto,
          token: config.interno.token,
          logsHabilitados: async () => (await leerPreferencias(db)).logsHabilitados,
          traerLogs: async (contenedorId, lineas) => {
            const preferencias = await leerPreferencias(db)
            if (fuentes.docker === null) throw new Error('Docker no configurado')
            return traerLogs(fuentes.docker, contenedorId, {
              maxLineas: Math.min(lineas, preferencias.logsMaxLineas),
              maxBytes: preferencias.logsMaxBytes,
            })
          },
        })
      : null

  if (servidorInterno !== null) {
    registrar('info', `API interna escuchando en el puerto ${config.interno.puerto}`)
  } else if (!config.interno.habilitado) {
    registrar('aviso', 'API interna apagada: sin COLLECTOR_TOKEN_INTERNO no hay logs')
  }

  /* --- Apagado ordenado ----------------------------------------------- */

  let apagando = false
  const apagar = async (senial: string): Promise<void> => {
    if (apagando) return
    apagando = true
    registrar('info', `recibí ${senial}, cerrando`)

    detenerMuestreo()
    detenerPersistencia()
    detenerCoolify()
    detenerMantenimiento()
    servidorInterno?.close()

    await pool.end().catch(() => {})
    process.exit(0)
  }

  process.on('SIGTERM', () => void apagar('SIGTERM'))
  process.on('SIGINT', () => void apagar('SIGINT'))

  registrar('info', 'collector en marcha')
}

main().catch((error: unknown) => {
  registrar('error', 'arranque fallido', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
