import { useState } from 'react'
import type { ClaveRango, ClaveSerie, Instantanea } from '@vmstats/shared'
import {
  UMBRALES,
  clasificar,
  formatearBytes,
  formatearEntero,
  formatearNumero,
  formatearPorcentaje,
  formatearTasa,
  porcentajeDe,
} from '@vmstats/shared'
import { Bloque, Dato, NoDisponible, Vacio } from '@/componentes/bloques'
import { Barra } from '@/componentes/estado'
import { GraficoSerie } from '@/componentes/GraficoSerie'
import { SelectorRango } from '@/componentes/SelectorRango'
import { TablaAdaptable } from '@/componentes/TablaAdaptable'
import { DEFINICIONES, Pista } from '@/components/ui/pista'
import { useHistorial } from '@/hooks/useHistorial'

/* ============================================================================
 * Recursos.
 *
 * El detalle de la máquina. A diferencia del Resumen, acá se puede mirar hacia
 * atrás: el selector de rango gobierna todos los gráficos de la vista a la vez,
 * porque comparar CPU con I/O en ventanas distintas no dice nada.
 * ========================================================================== */

const SERIES_CPU: ClaveSerie[] = ['cpu.total', 'cpu.iowait', 'cpu.steal']
const SERIES_CARGA: ClaveSerie[] = ['carga.uno', 'carga.cinco', 'carga.quince']
const SERIES_MEMORIA: ClaveSerie[] = ['memoria.usada', 'memoria.cache', 'memoria.swapUsada']
const SERIES_RED: ClaveSerie[] = ['red.rx', 'red.tx']
const SERIES_DISCO: ClaveSerie[] = ['disco.lectura', 'disco.escritura']
const SERIES_PRESION: ClaveSerie[] = ['presion.cpu', 'presion.memoria', 'presion.io']

interface Props {
  instantanea: Instantanea | null
  zonaHoraria: string
}

export function Recursos({ instantanea, zonaHoraria }: Props) {
  const [rango, setRango] = useState<ClaveRango>('1h')
  const host = instantanea?.host ?? null

  const cpu = useHistorial({ series: SERIES_CPU, rango })
  const carga = useHistorial({ series: SERIES_CARGA, rango })
  const memoria = useHistorial({ series: SERIES_MEMORIA, rango })
  const red = useHistorial({ series: SERIES_RED, rango })
  const disco = useHistorial({ series: SERIES_DISCO, rango })
  const presion = useHistorial({ series: SERIES_PRESION, rango })

  if (host === null) {
    return <Vacio titulo="Todavía no hay datos" detalle="Esperando la primera muestra." />
  }

  const memoriaPct = porcentajeDe(host.memoria.usada, host.memoria.total)
  const swapPct =
    host.memoria.swapTotal === 0
      ? null
      : porcentajeDe(host.memoria.swapUsada, host.memoria.swapTotal)

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SelectorRango valor={rango} onCambiar={setRango} />
        {cpu.datos !== null && (
          <span className="text-muted-foreground text-xs">
            resolución {cpu.datos.resolucion} · {cpu.datos.bucketSegundos} s por punto
            {cpu.datos.degradado && ' · granularidad reducida por retención'}
          </span>
        )}
      </div>

      {/* --- CPU --------------------------------------------------------- */}
      <Bloque titulo="CPU" nota={`${host.carga.nucleos} núcleos`}>
        <GraficoSerie
          titulo="Uso de CPU"
          series={cpu.datos?.series ?? []}
          eventos={cpu.eventos}
          cargando={cpu.cargando}
          zonaHoraria={zonaHoraria}
          ejeFijoPorcentaje
        />

        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <Dato etiqueta="Usuario" valor={formatearPorcentaje(host.cpu.user)} />
          <Dato etiqueta="Sistema" valor={formatearPorcentaje(host.cpu.system)} />
          <Dato
            etiqueta="iowait"
            valor={formatearPorcentaje(host.cpu.iowait)}
            explicacion={DEFINICIONES.iowait}
          />
          <Dato
            etiqueta="steal"
            valor={formatearPorcentaje(host.cpu.steal)}
            explicacion={DEFINICIONES.steal}
          />
        </div>

        {host.cpu.porNucleo.length > 0 && (
          <div>
            <span className="text-muted-foreground mb-2 block text-xs">Por núcleo</span>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 xl:grid-cols-8">
              {host.cpu.porNucleo.map((valor, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground text-xs">#{i}</span>
                    <span className="cifra text-xs">{formatearPorcentaje(valor, 0)}</span>
                  </div>
                  <Barra
                    porcentaje={valor}
                    estado={clasificar(valor, UMBRALES.cpu)}
                    etiqueta={`Núcleo ${i}`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </Bloque>

      {/* --- Carga ------------------------------------------------------- */}
      <Bloque
        titulo="Carga"
        nota={
          <Pista explicacion={DEFINICIONES.carga}>
            {formatearNumero(host.carga.uno / Math.max(1, host.carga.nucleos))} por núcleo
          </Pista>
        }
      >
        <GraficoSerie
          titulo="Load average"
          series={carga.datos?.series ?? []}
          cargando={carga.cargando}
          zonaHoraria={zonaHoraria}
          altura={160}
        />
      </Bloque>

      {/* --- Memoria ----------------------------------------------------- */}
      <Bloque titulo="Memoria" nota={formatearBytes(host.memoria.total)}>
        <GraficoSerie
          titulo="Uso de memoria"
          series={memoria.datos?.series ?? []}
          cargando={memoria.cargando}
          zonaHoraria={zonaHoraria}
        />

        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-6">
          <Dato etiqueta="Usada" valor={formatearBytes(host.memoria.usada)} />
          <Dato etiqueta="Disponible" valor={formatearBytes(host.memoria.disponible)} />
          <Dato etiqueta="Cache" valor={formatearBytes(host.memoria.cache)} />
          <Dato etiqueta="Buffers" valor={formatearBytes(host.memoria.buffers)} />
          <Dato
            etiqueta="Swap"
            valor={
              host.memoria.swapTotal === 0
                ? 'sin swap'
                : `${formatearBytes(host.memoria.swapUsada)} / ${formatearBytes(host.memoria.swapTotal)}`
            }
            explicacion={DEFINICIONES.swap}
          />
          <Dato etiqueta="Uso" valor={formatearPorcentaje(memoriaPct)} />
        </div>

        <div className="flex flex-col gap-2">
          <Barra
            porcentaje={memoriaPct}
            estado={clasificar(memoriaPct, UMBRALES.memoria)}
            etiqueta="Memoria usada"
          />
          {swapPct !== null && (
            <Barra
              porcentaje={swapPct}
              estado={clasificar(swapPct, UMBRALES.swap)}
              etiqueta="Swap usada"
            />
          )}
        </div>
      </Bloque>

      {/* --- Filesystems ------------------------------------------------- */}
      <Bloque titulo="Filesystems">
        {host.filesystems.length === 0 ? (
          <NoDisponible
            que="Filesystems"
            porque="No se pudo leer ningún punto de montaje. Dentro de un contenedor esto suele significar que falta montar el filesystem del host en modo lectura."
          />
        ) : (
          <ul className="divide-border divide-y">
            {host.filesystems.map((fs) => {
              const usadoPct = porcentajeDe(fs.usado, fs.tamanio)
              const inodosPct =
                fs.inodosTotal === null || fs.inodosUsados === null
                  ? null
                  : porcentajeDe(fs.inodosUsados, fs.inodosTotal)

              return (
                <li key={fs.puntoMontaje} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-mono text-sm">{fs.puntoMontaje}</span>
                    <span className="text-muted-foreground text-xs">
                      {fs.dispositivo} · {fs.tipo}
                    </span>
                    <span className="cifra ml-auto text-sm">
                      {formatearBytes(fs.usado)} de {formatearBytes(fs.tamanio)} ·{' '}
                      {formatearPorcentaje(usadoPct, 0)}
                    </span>
                  </div>

                  <Barra
                    porcentaje={usadoPct}
                    estado={clasificar(usadoPct, UMBRALES.disco)}
                    etiqueta={`Uso de ${fs.puntoMontaje}`}
                  />

                  <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
                    <span>Libre {formatearBytes(fs.disponible)}</span>
                    {inodosPct !== null && (
                      // Los inodos se llenan por separado del espacio: un
                      // filesystem con 40 % usado puede no aceptar un archivo
                      // más. Por eso se muestran siempre que existan.
                      <span>
                        Inodos {formatearEntero(fs.inodosUsados)} de{' '}
                        {formatearEntero(fs.inodosTotal)} ·{' '}
                        {formatearPorcentaje(inodosPct, 0)}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Bloque>

      {/* --- Disco ------------------------------------------------------- */}
      <Bloque titulo="Actividad de disco">
        {host.capacidades.ioDisco ? (
          <>
            <GraficoSerie
              titulo="Lectura y escritura de disco"
              series={disco.datos?.series ?? []}
              cargando={disco.cargando}
              zonaHoraria={zonaHoraria}
              altura={160}
            />
            <TablaAdaptable
              titulo="Actividad por dispositivo de disco"
              filas={host.discos}
              clave={(d) => d.dispositivo}
              tituloFila={(d) => <span className="font-mono">{d.dispositivo}</span>}
              columnas={[
                {
                  clave: 'dispositivo',
                  etiqueta: 'Dispositivo',
                  render: (d) => <span className="font-mono text-xs">{d.dispositivo}</span>,
                  prioridad: 'secundaria',
                },
                {
                  clave: 'lectura',
                  etiqueta: 'Lectura',
                  numerica: true,
                  render: (d) => formatearTasa(d.lecturaBytesPorSeg),
                },
                {
                  clave: 'escritura',
                  etiqueta: 'Escritura',
                  numerica: true,
                  render: (d) => formatearTasa(d.escrituraBytesPorSeg),
                },
                {
                  clave: 'iops',
                  etiqueta: 'IOPS',
                  numerica: true,
                  prioridad: 'secundaria',
                  render: (d) => formatearEntero(d.lecturaOpsPorSeg + d.escrituraOpsPorSeg),
                },
                {
                  clave: 'latencia',
                  etiqueta: 'Latencia',
                  numerica: true,
                  prioridad: 'secundaria',
                  render: (d) =>
                    d.latenciaLecturaMs === null
                      ? '—'
                      : `${formatearNumero(d.latenciaLecturaMs, 1)} ms`,
                },
                {
                  clave: 'uso',
                  etiqueta: 'Uso',
                  numerica: true,
                  prioridad: 'secundaria',
                  render: (d) => formatearPorcentaje(d.utilizacion, 0),
                },
              ]}
            />
          </>
        ) : (
          <NoDisponible
            que="Actividad de disco"
            porque="Este host no expone /proc/diskstats con dispositivos reales."
          />
        )}
      </Bloque>

      {/* --- Red --------------------------------------------------------- */}
      <Bloque titulo="Red">
        <GraficoSerie
          titulo="Tráfico de red"
          series={red.datos?.series ?? []}
          cargando={red.cargando}
          zonaHoraria={zonaHoraria}
          altura={160}
        />

        <TablaAdaptable
          titulo="Tráfico por interfaz de red"
          filas={host.red}
          clave={(i) => i.interfaz}
          tituloFila={(i) => <span className="font-mono">{i.interfaz}</span>}
          columnas={[
            {
              clave: 'interfaz',
              etiqueta: 'Interfaz',
              prioridad: 'secundaria',
              render: (i) => <span className="font-mono text-xs">{i.interfaz}</span>,
            },
            {
              clave: 'rx',
              etiqueta: 'Entrada',
              numerica: true,
              render: (i) => formatearTasa(i.rxBytesPorSeg),
            },
            {
              clave: 'tx',
              etiqueta: 'Salida',
              numerica: true,
              render: (i) => formatearTasa(i.txBytesPorSeg),
            },
            {
              clave: 'errores',
              etiqueta: 'Errores',
              numerica: true,
              prioridad: 'secundaria',
              render: (i) => formatearEntero(i.rxErrores + i.txErrores),
            },
            {
              clave: 'descartes',
              etiqueta: 'Descartes',
              numerica: true,
              prioridad: 'secundaria',
              render: (i) => formatearEntero(i.rxDescartes + i.txDescartes),
            },
          ]}
        />

        {host.tcp !== null && (
          <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
            <Dato
              etiqueta="Establecidas"
              valor={formatearEntero(host.tcp.establecidas)}
              explicacion={DEFINICIONES.tcp}
            />
            <Dato etiqueta="Escuchando" valor={formatearEntero(host.tcp.escuchando)} />
            <Dato etiqueta="time-wait" valor={formatearEntero(host.tcp.timeWait)} />
            <Dato etiqueta="Total" valor={formatearEntero(host.tcp.total)} />
          </div>
        )}
      </Bloque>

      {/* --- Presión ----------------------------------------------------- */}
      <Bloque titulo="Presión (PSI)">
        {host.capacidades.presion ? (
          <GraficoSerie
            titulo="Presión de recursos"
            series={presion.datos?.series ?? []}
            cargando={presion.cargando}
            zonaHoraria={zonaHoraria}
            ejeFijoPorcentaje
            altura={160}
          />
        ) : (
          <NoDisponible
            que="PSI"
            porque="El kernel de este host no expone /proc/pressure. Hace falta Linux 4.20 o posterior compilado con CONFIG_PSI."
          />
        )}
      </Bloque>

      {/* --- Procesos ---------------------------------------------------- */}
      <Bloque titulo="Procesos" nota="por CPU y memoria">
        {host.procesos.length === 0 ? (
          <NoDisponible
            que="Procesos"
            porque="No se pudo leer /proc de los procesos del host."
          />
        ) : (
          <TablaAdaptable
            titulo="Procesos que más CPU y memoria consumen"
            filas={host.procesos.toSorted((a, b) => b.cpuPorcentaje - a.cpuPorcentaje)}
            clave={(p) => String(p.pid)}
            tituloFila={(p) => <span className="font-mono">{p.comando}</span>}
            columnas={[
              {
                clave: 'pid',
                etiqueta: 'PID',
                prioridad: 'secundaria',
                render: (p) => p.pid,
              },
              {
                clave: 'comando',
                etiqueta: 'Comando',
                prioridad: 'secundaria',
                render: (p) => <span className="font-mono text-xs">{p.comando}</span>,
              },
              {
                clave: 'usuario',
                etiqueta: 'Usuario',
                prioridad: 'secundaria',
                render: (p) => p.usuario,
              },
              {
                clave: 'cpu',
                etiqueta: 'CPU',
                numerica: true,
                render: (p) => formatearPorcentaje(p.cpuPorcentaje, 1),
              },
              {
                clave: 'memoria',
                etiqueta: 'Memoria',
                numerica: true,
                render: (p) => formatearBytes(p.memoriaBytes),
              },
            ]}
          />
        )}
        <p className="text-muted-foreground text-xs">
          Sólo el nombre del comando, sin argumentos: los argumentos filtran tokens y
          contraseñas con demasiada facilidad.
        </p>
      </Bloque>

      {/* --- Temperatura ------------------------------------------------- */}
      {host.capacidades.temperatura && host.temperaturas.length > 0 && (
        <Bloque titulo="Temperatura">
          <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
            {host.temperaturas.map((t) => (
              <Dato
                key={t.etiqueta}
                etiqueta={t.etiqueta}
                valor={`${formatearNumero(t.celsius, 1)} °C`}
              />
            ))}
          </div>
        </Bloque>
      )}
    </>
  )
}
