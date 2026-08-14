import { useMemo } from 'react'
import { ArrowRightIcon } from 'lucide-react'
import type { EstadoGeneral, Instantanea, MetricaAlerta, MuestraHost } from '@vmstats/shared'
import {
  METRICAS_ALERTA,
  UMBRALES,
  clasificar,
  formatearBytes,
  formatearDuracion,
  formatearEntero,
  formatearFechaHora,
  formatearNumero,
  formatearPorcentaje,
  formatearTasa,
  peorEstado,
  porcentajeDe,
} from '@vmstats/shared'
import { Bloque, Dato, Metrica, Vacio } from '@/componentes/bloques'
import { IndicadorEstado, PuntoEstado } from '@/componentes/estado'
import { LineaPulso, type PuntoPulso } from '@/componentes/LineaPulso'
import { DEFINICIONES } from '@/components/ui/pista'
import { Button } from '@/components/ui/button'
import { Etiqueta } from '@/components/ui/varios'
import type { Vista } from '@/componentes/Consola'

/**
 * Valor de alerta con la precisión que corresponde a su métrica.
 *
 * Un contador de contenedores caídos se lee «2», no «2,00».
 */
function valorDeAlerta(valor: number, metrica: MetricaAlerta): string {
  const unidad = METRICAS_ALERTA[metrica].unidad
  if (unidad === 'B/s') return formatearTasa(valor)
  if (unidad === '') {
    return Number.isInteger(valor) ? formatearEntero(valor) : formatearNumero(valor, 2)
  }
  return `${formatearNumero(valor, 1)} ${unidad}`
}

/* ============================================================================
 * Resumen.
 *
 * La pantalla que se mira de reojo. Responde tres preguntas en orden: ¿está
 * bien?, ¿qué está haciendo ahora?, ¿pasó algo que deba mirar?
 *
 * Todo lo que aparece acá es accionable o es contexto de algo accionable. Las
 * métricas de detalle viven en Recursos; duplicarlas acá convertiría el
 * resumen en un tablero más.
 * ========================================================================== */

interface Props {
  instantanea: Instantanea | null
  pulso: readonly PuntoPulso[]
  desactualizado: boolean
  zonaHoraria: string
  onIrA: (vista: Vista) => void
}

/** El filesystem con mayor porcentaje de uso: es el que va a romper primero. */
function discoMasLleno(host: MuestraHost) {
  let peor: { punto: string; usado: number; total: number; porcentaje: number } | null = null

  for (const fs of host.filesystems) {
    const porcentaje = porcentajeDe(fs.usado, fs.tamanio)
    if (porcentaje === null) continue
    if (peor === null || porcentaje > peor.porcentaje) {
      peor = { punto: fs.puntoMontaje, usado: fs.usado, total: fs.tamanio, porcentaje }
    }
  }

  return peor
}

export function Resumen({ instantanea, pulso, desactualizado, zonaHoraria, onIrA }: Props) {
  const host = instantanea?.host ?? null

  const estados = useMemo(() => {
    if (host === null) return null

    const memoriaPct = porcentajeDe(host.memoria.usada, host.memoria.total)
    const swapPct =
      host.memoria.swapTotal === 0
        ? null
        : porcentajeDe(host.memoria.swapUsada, host.memoria.swapTotal)
    const disco = discoMasLleno(host)
    const cargaPorNucleo = host.carga.nucleos > 0 ? host.carga.uno / host.carga.nucleos : null

    return {
      cpu: clasificar(host.cpu.total, UMBRALES.cpu),
      memoria: clasificar(memoriaPct, UMBRALES.memoria),
      swap: swapPct === null ? ('saludable' as EstadoGeneral) : clasificar(swapPct, UMBRALES.swap),
      disco: clasificar(disco?.porcentaje ?? null, UMBRALES.disco),
      carga: clasificar(cargaPorNucleo, UMBRALES.cargaPorNucleo),
      memoriaPct,
      swapPct,
      discoDetalle: disco,
      cargaPorNucleo,
    }
  }, [host])

  if (host === null || estados === null) {
    return (
      <Vacio
        titulo="Todavía no hay datos"
        detalle="Cuando el collector complete su primer ciclo, esta pantalla se llena sola."
      />
    )
  }

  const alertas = instantanea?.alertasAbiertas ?? []
  const criticas = alertas.filter((a) => a.severidad === 'critical')
  const contenedoresConProblemas = (instantanea?.contenedores ?? []).filter(
    (c) => c.salud === 'unhealthy' || c.estado === 'restarting' || c.estado === 'dead',
  )

  /* El estado general es el peor de todo lo que sabemos. Con datos viejos es
   * «sin datos» y no «saludable»: decir que está sano mirando una foto de hace
   * una hora es la peor mentira que puede contar esta pantalla. */
  const general: EstadoGeneral = desactualizado
    ? 'sin-datos'
    : peorEstado([
        estados.cpu,
        estados.memoria,
        estados.swap,
        estados.disco,
        estados.carga,
        criticas.length > 0 ? 'critico' : 'saludable',
        alertas.length > 0 ? 'advertencia' : 'saludable',
        contenedoresConProblemas.length > 0 ? 'advertencia' : 'saludable',
      ])

  const redTotal = host.red.reduce((s, i) => s + i.rxBytesPorSeg + i.txBytesPorSeg, 0)
  const rx = host.red.reduce((s, i) => s + i.rxBytesPorSeg, 0)
  const tx = host.red.reduce((s, i) => s + i.txBytesPorSeg, 0)

  return (
    <>
      {/* --- Franja de estado general ------------------------------------ */}
      <section
        aria-label="Estado general"
        className="border-border flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-4"
      >
        <IndicadorEstado estado={general} />

        <Dato etiqueta="Uptime" valor={formatearDuracion(host.uptimeSegundos)} />

        <div className="flex items-baseline gap-3">
          <span className="text-muted-foreground text-xs">Última muestra</span>
          <span className="cifra text-sm">{formatearFechaHora(host.ts, zonaHoraria)}</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {alertas.length > 0 && (
            <Button
              tamanio="sm"
              variante="contorno"
              onClick={() => onIrA('alerts')}
              className="border-critico/30"
            >
              <Etiqueta variante={criticas.length > 0 ? 'critica' : 'aviso'}>
                {alertas.length}
              </Etiqueta>
              {alertas.length === 1 ? 'alerta abierta' : 'alertas abiertas'}
              <ArrowRightIcon aria-hidden />
            </Button>
          )}

          {contenedoresConProblemas.length > 0 && (
            <Button tamanio="sm" variante="contorno" onClick={() => onIrA('containers')}>
              <Etiqueta variante="aviso">{contenedoresConProblemas.length}</Etiqueta>
              con problemas
              <ArrowRightIcon aria-hidden />
            </Button>
          )}

          {(instantanea?.desplieguesActivos.length ?? 0) > 0 && (
            <Button tamanio="sm" variante="contorno" onClick={() => onIrA('deployments')}>
              {instantanea?.desplieguesActivos.length} desplegando
              <ArrowRightIcon aria-hidden />
            </Button>
          )}
        </div>
      </section>

      {/* --- Línea de pulso ---------------------------------------------- */}
      <Bloque titulo="Pulso" nota="CPU, memoria y red en vivo">
        <LineaPulso puntos={pulso} desactualizado={desactualizado} />
      </Bloque>

      {/* --- Ahora ------------------------------------------------------- */}
      <Bloque titulo="Ahora">
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
          <Metrica
            etiqueta="CPU"
            valor={formatearPorcentaje(host.cpu.total, 1)}
            crudo={host.cpu.total}
            porcentaje={host.cpu.total}
            estado={estados.cpu}
            explicacion={DEFINICIONES.cpu}
            contexto={
              <>
                load {formatearNumero(host.carga.uno)} · {host.carga.nucleos} núcleos
                {host.cpu.steal > 1 && ` · ${formatearPorcentaje(host.cpu.steal, 0)} robada`}
              </>
            }
          />

          <Metrica
            etiqueta="Memoria"
            valor={formatearPorcentaje(estados.memoriaPct, 1)}
            crudo={estados.memoriaPct}
            porcentaje={estados.memoriaPct}
            estado={estados.memoria}
            explicacion={DEFINICIONES.memoria}
            contexto={
              <>
                {formatearBytes(host.memoria.usada)} de {formatearBytes(host.memoria.total)}
                {estados.swapPct !== null &&
                  estados.swapPct > 1 &&
                  ` · swap ${formatearPorcentaje(estados.swapPct, 0)}`}
              </>
            }
          />

          <Metrica
            etiqueta="Disco"
            valor={formatearPorcentaje(estados.discoDetalle?.porcentaje ?? null, 1)}
            crudo={estados.discoDetalle?.porcentaje ?? null}
            porcentaje={estados.discoDetalle?.porcentaje ?? null}
            estado={estados.disco}
            explicacion={DEFINICIONES.disco}
            contexto={
              estados.discoDetalle === null ? (
                'sin filesystems legibles'
              ) : (
                <>
                  {estados.discoDetalle.punto} · {formatearBytes(estados.discoDetalle.usado)} de{' '}
                  {formatearBytes(estados.discoDetalle.total)}
                </>
              )
            }
          />

          <Metrica
            etiqueta="Red"
            valor={formatearTasa(redTotal)}
            crudo={redTotal}
            explicacion={DEFINICIONES.red}
            contexto={
              <>
                ↓ {formatearTasa(rx)} · ↑ {formatearTasa(tx)}
              </>
            }
          />
        </div>
      </Bloque>

      {/* --- Lo que hay que mirar ---------------------------------------- */}
      {alertas.length > 0 && (
        <Bloque
          titulo="Alertas abiertas"
          acciones={
            <Button tamanio="sm" variante="fantasma" onClick={() => onIrA('alerts')}>
              Ver todas <ArrowRightIcon aria-hidden />
            </Button>
          }
        >
          <ul className="divide-border divide-y">
            {alertas.slice(0, 5).map((alerta) => (
              <li key={alerta.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <PuntoEstado estado={alerta.severidad === 'critical' ? 'critico' : 'advertencia'} />
                <span className="text-sm font-medium">{alerta.reglaNombre}</span>
                <span className="text-muted-foreground cifra text-xs">
                  {valorDeAlerta(alerta.valorDisparo, alerta.metrica)} · umbral{' '}
                  {valorDeAlerta(alerta.umbral, alerta.metrica)}
                </span>
                {alerta.estado === 'reconocida' && (
                  <Etiqueta variante="neutra">Reconocida</Etiqueta>
                )}
                <span className="text-muted-foreground ml-auto text-xs">
                  desde {formatearFechaHora(alerta.iniciadaEn, zonaHoraria)}
                </span>
              </li>
            ))}
          </ul>
        </Bloque>
      )}

      {contenedoresConProblemas.length > 0 && (
        <Bloque
          titulo="Contenedores con problemas"
          acciones={
            <Button tamanio="sm" variante="fantasma" onClick={() => onIrA('containers')}>
              Ver todos <ArrowRightIcon aria-hidden />
            </Button>
          }
        >
          <ul className="divide-border divide-y">
            {contenedoresConProblemas.slice(0, 5).map((c) => (
              <li key={c.contenedorId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <PuntoEstado
                  estado={c.estado === 'dead' ? 'critico' : 'advertencia'}
                  texto={c.salud === 'unhealthy' ? 'Healthcheck fallando' : c.estado}
                />
                <span className="text-sm font-medium">{c.nombre}</span>
                <Etiqueta variante={c.estado === 'dead' ? 'critica' : 'aviso'}>
                  {c.salud === 'unhealthy' ? 'unhealthy' : c.estado}
                </Etiqueta>
                {c.reinicios > 0 && (
                  <span className="text-muted-foreground cifra text-xs">
                    {c.reinicios} reinicios
                  </span>
                )}
                {c.coolifyAplicacion !== null && (
                  <span className="text-muted-foreground ml-auto text-xs">
                    {c.coolifyAplicacion}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Bloque>
      )}

      {alertas.length === 0 && contenedoresConProblemas.length === 0 && !desactualizado && (
        <Bloque titulo="Sin novedades">
          <p className="text-muted-foreground text-sm">
            Ninguna alerta abierta y todos los contenedores en marcha. El detalle está en
            Recursos y en Contenedores.
          </p>
        </Bloque>
      )}
    </>
  )
}
