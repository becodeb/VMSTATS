import { sql } from 'drizzle-orm'
import { baseDesdeUrl } from './index.js'
import { usuarios } from './schema.js'
import { crearClave, esAlcance, listarClaves, revocarClave } from './clavesApi.js'

/* ============================================================================
 * Emisión de claves de API desde la línea de comandos.
 *
 * Existe para lo que la consola no puede resolver: dejar una clave lista en un
 * despliegue nuevo, o recuperar el acceso programático sin abrir un navegador.
 *
 *     docker compose exec web node /app/packages/db/dist/clave.js crear \
 *       --email alguien@ejemplo.com --nombre "ci" --alcance read --dias 90
 *
 * Igual que el bootstrap, vive en @vmstats/db para que corra dentro de la
 * imagen de producción.
 *
 * El secreto se imprime una única vez y sólo por stdout. No queda en la base ni
 * en ningún log: si se pierde, se revoca y se emite otro.
 * ========================================================================== */

interface Argumentos {
  comando: string
  opciones: Map<string, string>
}

function parsear(argv: readonly string[]): Argumentos {
  const comando = argv[0] ?? 'ayuda'
  const opciones = new Map<string, string>()

  for (let i = 1; i < argv.length; i += 1) {
    const actual = argv[i]
    if (actual === undefined || !actual.startsWith('--')) continue
    const siguiente = argv[i + 1]
    // Una bandera sin valor vale como cadena vacía; el validador de abajo la
    // rechaza con un mensaje útil en vez de tomar la bandera que sigue.
    opciones.set(actual.slice(2), siguiente !== undefined && !siguiente.startsWith('--') ? siguiente : '')
    if (siguiente !== undefined && !siguiente.startsWith('--')) i += 1
  }

  return { comando, opciones }
}

const AYUDA = `
Uso: node clave.js <comando> [opciones]

Comandos:
  crear    --email <email> --nombre <nombre> [--alcance read|admin] [--dias N]
  listar   --email <email>
  revocar  --email <email> --id <id>

Alcances:
  read     Sólo GET y HEAD. Es el valor por defecto.
  admin    También mutaciones (reglas de alerta, silencios, preferencias).

Sin --dias la clave no vence. Conviene ponerle un plazo.
`.trim()

async function principal(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url.length === 0) {
    console.error('Falta DATABASE_URL.')
    process.exitCode = 1
    return
  }

  const { comando, opciones } = parsear(process.argv.slice(2))

  if (comando === 'ayuda' || comando === '--help' || comando === '-h') {
    console.log(AYUDA)
    return
  }

  const email = opciones.get('email') ?? ''
  if (email.length === 0) {
    console.error('Falta --email.\n')
    console.error(AYUDA)
    process.exitCode = 1
    return
  }

  const { pool, db } = baseDesdeUrl({ url, maxConexiones: 2 })

  try {
    const encontrados = await db
      .select({ id: usuarios.id, email: usuarios.email })
      .from(usuarios)
      .where(sql`lower(${usuarios.email}) = lower(${email})`)
      .limit(1)

    const usuario = encontrados[0]
    if (usuario === undefined) {
      console.error(`No existe ningún usuario con el email ${email}.`)
      process.exitCode = 1
      return
    }

    switch (comando) {
      case 'crear': {
        const alcance = opciones.get('alcance') ?? 'read'
        if (!esAlcance(alcance)) {
          console.error(`Alcance inválido: ${alcance}. Usá "read" o "admin".`)
          process.exitCode = 1
          return
        }

        const diasCrudo = opciones.get('dias')
        let diasValidez: number | null = null
        if (diasCrudo !== undefined && diasCrudo.length > 0) {
          const n = Number.parseInt(diasCrudo, 10)
          if (!Number.isInteger(n) || n <= 0) {
            console.error(`--dias tiene que ser un entero positivo, no "${diasCrudo}".`)
            process.exitCode = 1
            return
          }
          diasValidez = n
        }

        const nombre = opciones.get('nombre') ?? ''
        if (nombre.length === 0) {
          console.error('Falta --nombre. Sirve para saber después qué es cada clave.')
          process.exitCode = 1
          return
        }

        const { secreto, clave } = await crearClave(db, {
          usuarioId: usuario.id,
          nombre,
          alcance,
          diasValidez,
        })

        console.log(`\nClave creada para ${usuario.email}.`)
        console.log(`  nombre:  ${clave.nombre}`)
        console.log(`  alcance: ${clave.alcance}`)
        console.log(`  vence:   ${clave.expiraEn ?? 'nunca'}`)
        console.log('\nGuardala ahora. No se vuelve a mostrar:\n')
        console.log(`  ${secreto}\n`)
        console.log('Ejemplo de uso:')
        console.log(`  curl -H "Authorization: Bearer ${secreto}" <URL>/api/instantanea\n`)
        return
      }

      case 'listar': {
        const claves = await listarClaves(db, usuario.id)
        if (claves.length === 0) {
          console.log(`${usuario.email} no tiene claves activas.`)
          return
        }
        console.log(`Claves activas de ${usuario.email}:\n`)
        for (const c of claves) {
          console.log(`  ${c.nombre}  [${c.alcance}]  vmst_${c.prefijo}…`)
          console.log(`    id:    ${c.id}`)
          console.log(`    creada ${c.creadaEn}   vence ${c.expiraEn ?? 'nunca'}`)
          console.log(`    último uso: ${c.usadaEn ?? 'sin usar'}\n`)
        }
        return
      }

      case 'revocar': {
        const id = opciones.get('id') ?? ''
        if (id.length === 0) {
          console.error('Falta --id. Sacalo de `clave.js listar`.')
          process.exitCode = 1
          return
        }
        const ok = await revocarClave(db, usuario.id, id)
        if (!ok) {
          console.error('No se encontró esa clave activa para ese usuario.')
          process.exitCode = 1
          return
        }
        console.log('Clave revocada. Deja de funcionar de inmediato.')
        return
      }

      default:
        console.error(`Comando desconocido: ${comando}\n`)
        console.error(AYUDA)
        process.exitCode = 1
    }
  } catch (causa) {
    console.error('Falló:', causa instanceof Error ? causa.message : causa)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await principal()
