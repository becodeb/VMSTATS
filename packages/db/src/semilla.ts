
import { reglasAlerta } from './schema.js'
import { PREFERENCIAS_POR_DEFECTO } from './configuracion.js'
import { configuracion } from './schema.js'
import type { BaseDatos } from './index.js'

/* ============================================================================
 * Semilla de arranque.
 *
 * Sólo configuración y reglas de alerta. Ningún usuario: la spec prohíbe
 * credenciales por defecto, así que el primer admin se crea a mano con
 * `npm run bootstrap:admin`.
 *
 * No hay datos de demo acá. Los datos falsos viven detrás de
 * `VMSTATS_DEMO=1` en el collector y nunca tocan una base de producción.
 * ========================================================================== */

interface ReglaSemilla {
  nombre: string
  metrica: string
  operador: 'mayor' | 'menor'
  umbral: number
  severidad: 'warning' | 'critical'
  duracionMinimaSegundos: number
  cooldownSegundos: number
  histeresis: number
}

/**
 * Reglas iniciales.
 *
 * Los umbrales son deliberadamente conservadores y las duraciones mínimas
 * largas: una consola que grita por cada pico de treinta segundos se ignora a
 * la semana. La histéresis está siempre por encima de cero para que un valor
 * pegado al umbral no genere una alerta por muestra.
 */
export const REGLAS_INICIALES: readonly ReglaSemilla[] = [
  {
    nombre: 'CPU alta sostenida',
    metrica: 'cpu.total',
    operador: 'mayor',
    umbral: 85,
    severidad: 'warning',
    duracionMinimaSegundos: 300,
    cooldownSegundos: 600,
    histeresis: 5,
  },
  {
    nombre: 'CPU saturada',
    metrica: 'cpu.total',
    operador: 'mayor',
    umbral: 95,
    severidad: 'critical',
    duracionMinimaSegundos: 180,
    cooldownSegundos: 600,
    histeresis: 5,
  },
  {
    nombre: 'Memoria alta',
    metrica: 'memoria.usadaPorcentaje',
    operador: 'mayor',
    umbral: 88,
    severidad: 'warning',
    duracionMinimaSegundos: 300,
    cooldownSegundos: 600,
    histeresis: 4,
  },
  {
    nombre: 'Memoria crítica',
    metrica: 'memoria.usadaPorcentaje',
    operador: 'mayor',
    umbral: 95,
    severidad: 'critical',
    duracionMinimaSegundos: 120,
    cooldownSegundos: 600,
    histeresis: 4,
  },
  {
    nombre: 'Swap en uso',
    metrica: 'memoria.swapPorcentaje',
    operador: 'mayor',
    umbral: 30,
    severidad: 'warning',
    duracionMinimaSegundos: 600,
    cooldownSegundos: 1800,
    histeresis: 8,
  },
  {
    nombre: 'Filesystem casi lleno',
    metrica: 'disco.usadoPorcentaje',
    operador: 'mayor',
    umbral: 85,
    severidad: 'warning',
    duracionMinimaSegundos: 600,
    cooldownSegundos: 3600,
    histeresis: 3,
  },
  {
    nombre: 'Filesystem lleno',
    metrica: 'disco.usadoPorcentaje',
    operador: 'mayor',
    umbral: 93,
    severidad: 'critical',
    duracionMinimaSegundos: 300,
    cooldownSegundos: 3600,
    histeresis: 3,
  },
  {
    // En una VM esto no se arregla desde adentro: es el hipervisor. Vale como
    // advertencia para saber que el problema no es tuyo.
    nombre: 'CPU robada por el hipervisor',
    metrica: 'cpu.steal',
    operador: 'mayor',
    umbral: 10,
    severidad: 'warning',
    duracionMinimaSegundos: 300,
    cooldownSegundos: 1800,
    histeresis: 3,
  },
  {
    nombre: 'Presión de I/O',
    metrica: 'presion.io',
    operador: 'mayor',
    umbral: 40,
    severidad: 'warning',
    duracionMinimaSegundos: 300,
    cooldownSegundos: 900,
    histeresis: 8,
  },
  {
    nombre: 'Contenedores no saludables',
    metrica: 'contenedor.caido',
    operador: 'mayor',
    umbral: 0,
    severidad: 'critical',
    duracionMinimaSegundos: 120,
    cooldownSegundos: 300,
    histeresis: 0,
  },
  {
    nombre: 'Collector sin reportar',
    metrica: 'collector.silencioSegundos',
    operador: 'mayor',
    umbral: 60,
    severidad: 'critical',
    duracionMinimaSegundos: 0,
    cooldownSegundos: 300,
    histeresis: 30,
  },
]

/**
 * Inserta preferencias y reglas si no existen.
 *
 * Las reglas se identifican por nombre: si el operador editó «CPU alta
 * sostenida», una nueva corrida de la semilla no le pisa el umbral.
 */
export async function sembrarConfiguracionInicial(db: BaseDatos): Promise<void> {
  await db
    .insert(configuracion)
    .values({ clave: 'preferencias', valor: PREFERENCIAS_POR_DEFECTO })
    .onConflictDoNothing()

  for (const regla of REGLAS_INICIALES) {
    await db
      .insert(reglasAlerta)
      .values({
        nombre: regla.nombre,
        metrica: regla.metrica,
        operador: regla.operador,
        umbral: regla.umbral,
        severidad: regla.severidad,
        duracionMinimaSegundos: regla.duracionMinimaSegundos,
        cooldownSegundos: regla.cooldownSegundos,
        histeresis: regla.histeresis,
        habilitada: true,
      })
      .onConflictDoNothing()
  }
}
