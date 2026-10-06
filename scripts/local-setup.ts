import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkOdooHost } from '../gateway/src/hosts.ts'
import { parseProjects, sha256Hex } from '../gateway/src/projects.ts'
import { generatePassword, hashPassword } from '../src/lib/password.ts'

/*
 * Local test set-up (docs/lokaal-testen.md): writes the configuration of a gateway and a dashboard that talk to
 * ONE local or test Odoo, into `.local/` (not in git). Secrets are generated here and never leave `.local/`;
 * the Odoo API key is NOT asked for or written: fill it in yourself in `.local/gateway.env`.
 *
 *   node --experimental-strip-types scripts/local-setup.ts [--odoo-url ...] [--database ...] [--company-id 1]
 *        [--responsible-id <Odoo user id>] [--force]
 *
 * Without --responsible-id the dashboard cannot create employees in Odoo (the action stays off). The planning roles of
 * a new technician are chosen by the admin in the dashboard, from the roles that exist in Odoo.
 */

export interface LocalSetupOptions {
  odooUrl: string
  database: string
  companyId: number
  /** The Odoo user who becomes hr_responsible_id; null leaves "add technician" switched off. */
  responsibleId: number | null
  adminUsername: string
  gatewayPort: number
  dashboardPort: number
  /** Directory of the generated files, relative to where the commands run (the repository root). */
  dir: string
}

export interface LocalSetupSecrets {
  gatewayToken: string
  sessionSecret: string
  adminPassword: string
}

export const FILE_NAMES = ['gateway-projects.json', 'gateway.env', 'dashboard.env'] as const
type FileName = (typeof FILE_NAMES)[number]

export const DEFAULTS: LocalSetupOptions = {
  odooUrl: 'http://localhost:8069',
  database: '',
  companyId: 1,
  responsibleId: null,
  adminUsername: 'admin',
  gatewayPort: 8070,
  dashboardPort: 3000,
  dir: '.local',
}

function positiveInteger(value: string | undefined, name: string, fallback: number | null): number | null {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error(`${name} moet een positief geheel getal zijn.`)
  return Number(value)
}

function singleLine(value: string, name: string): string {
  if (!value || /[\r\n#"'\s]/.test(value)) throw new Error(`${name} mag niet leeg zijn en geen spaties, aanhalingstekens, # of regeleinden bevatten.`)
  return value
}

/** Reads the command line options; throws an Error with a Dutch message for anything that is wrong. */
export function resolveOptions(values: Record<string, string | boolean | undefined>): LocalSetupOptions {
  const text = (name: string): string | undefined => (typeof values[name] === 'string' ? (values[name] as string) : undefined)
  const odooUrl = (text('odoo-url') ?? DEFAULTS.odooUrl).replace(/\/+$/, '')
  let host: URL
  try {
    host = new URL(odooUrl)
  } catch {
    throw new Error('--odoo-url is geen geldig adres.')
  }
  if (host.pathname !== '/' && host.pathname !== '') throw new Error('--odoo-url mag geen pad bevatten (alleen het adres van de server).')
  // The same rule as the gateway: Odoo.sh and odoo.com are never reachable, also not from this kit.
  try {
    checkOdooHost(odooUrl, [host.hostname.toLowerCase()])
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  if (host.protocol !== 'https:' && host.hostname !== 'localhost' && host.hostname !== '127.0.0.1') {
    throw new Error('Alleen localhost en 127.0.0.1 mogen met http; gebruik anders https.')
  }
  const responsibleId = positiveInteger(text('responsible-id'), '--responsible-id', null)
  return {
    odooUrl: host.origin,
    database: text('database') ? singleLine(text('database') as string, '--database') : DEFAULTS.database,
    companyId: positiveInteger(text('company-id'), '--company-id', DEFAULTS.companyId) as number,
    responsibleId,
    adminUsername: singleLine(text('admin-username') ?? DEFAULTS.adminUsername, '--admin-username'),
    gatewayPort: positiveInteger(text('gateway-port'), '--gateway-port', DEFAULTS.gatewayPort) as number,
    dashboardPort: positiveInteger(text('dashboard-port'), '--dashboard-port', DEFAULTS.dashboardPort) as number,
    dir: singleLine(text('dir') ?? DEFAULTS.dir, 'dir'),
  }
}

export function generateSecrets(): LocalSetupSecrets {
  return {
    gatewayToken: `dgw_${randomBytes(32).toString('base64url')}`,
    sessionSecret: randomBytes(48).toString('base64url'),
    adminPassword: generatePassword(),
  }
}

/**
 * The three files. `exampleProjects` is the content of gateway/projects.example.json, so that the allowlist of
 * models and fields stays in one place. The generated project config is checked with the gateway's own parser.
 */
export function buildLocalSetup(options: LocalSetupOptions, secrets: LocalSetupSecrets, exampleProjects: unknown): Record<FileName, string> {
  const example = (exampleProjects as { projects?: Array<Record<string, unknown>> } | null)?.projects?.[0]
  if (!example || typeof example !== 'object') throw new Error('gateway/projects.example.json heeft geen project.')

  const project: Record<string, unknown> = {
    ...example,
    tokenSha256: sha256Hex(secrets.gatewayToken),
    companyId: options.companyId,
  }
  if (options.responsibleId !== null) project.actions = { createEmployee: { responsibleUserId: options.responsibleId } }
  else delete project.actions
  const projects = { projects: [project] }
  parseProjects(projects) // throws when the gateway would refuse this file

  const host = new URL(options.odooUrl).hostname.toLowerCase()
  const lines = (entries: string[]) => `${entries.join('\n')}\n`
  return {
    'gateway-projects.json': `${JSON.stringify(projects, null, 2)}\n`,
    'gateway.env': lines([
      '# Local gateway (scripts/local-setup.ts). Fill in ODOO_API_KEY yourself: the API key of the Odoo test user.',
      `ODOO_BASE_URL=${options.odooUrl}`,
      ...(options.database ? [`ODOO_DATABASE=${options.database}`] : []),
      'ODOO_API_KEY=',
      `ODOO_ALLOWED_HOSTS=${host}`,
      `GATEWAY_PROJECTS_FILE=${path.posix.join(options.dir, 'gateway-projects.json')}`,
      `GATEWAY_PORT=${options.gatewayPort}`,
    ]),
    'dashboard.env': lines([
      '# Local dashboard (scripts/local-setup.ts). Secrets: keep this file out of git and out of chat.',
      `DIG_GATEWAY_URL=http://127.0.0.1:${options.gatewayPort}`,
      `DIG_GATEWAY_TOKEN=${secrets.gatewayToken}`,
      `ODOO_PUBLIC_URL=${options.odooUrl}`,
      `DIG_SESSION_SECRET=${secrets.sessionSecret}`,
      `DIG_DATA_DIR=${path.posix.join(options.dir, 'data')}`,
      `DIG_ADMIN_USERNAME=${options.adminUsername}`,
      `DIG_ADMIN_PASSWORD_HASH=${hashPassword(secrets.adminPassword)}`,
      'DIG_SECURE_COOKIES=false',
      `PORT=${options.dashboardPort}`,
      'HOST=127.0.0.1',
    ]),
  }
}

/** Writes the files (directory 0700, files 0600). Refuses to overwrite unless `force`; nothing is written then. */
export function writeLocalSetup(root: string, dir: string, files: Record<FileName, string>, force: boolean): string[] {
  const target = path.resolve(root, dir)
  const existing = FILE_NAMES.filter((name) => existsSync(path.join(target, name)))
  if (existing.length > 0 && !force) {
    throw new Error(`${existing.map((name) => path.join(dir, name)).join(', ')} bestaat al. Gebruik --force om te vervangen (dat maakt een nieuw token en een nieuw wachtwoord).`)
  }
  mkdirSync(target, { recursive: true, mode: 0o700 })
  chmodSync(target, 0o700)
  return FILE_NAMES.map((name) => {
    const file = path.join(target, name)
    writeFileSync(file, files[name], { mode: 0o600 })
    chmodSync(file, 0o600)
    return file
  })
}

function main() {
  const { values } = parseArgs({
    options: {
      'odoo-url': { type: 'string' },
      database: { type: 'string' },
      'company-id': { type: 'string' },
      'responsible-id': { type: 'string' },
      'admin-username': { type: 'string' },
      'gateway-port': { type: 'string' },
      'dashboard-port': { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options = resolveOptions(values)
  const secrets = generateSecrets()
  const example = JSON.parse(readFileSync(path.join(root, 'gateway', 'projects.example.json'), 'utf8')) as unknown
  const files = buildLocalSetup(options, secrets, example)
  const written = writeLocalSetup(root, options.dir, files, values.force === true)

  const out = (line = '') => console.log(line)
  out('Klaar. Geschreven (alleen voor jou leesbaar, niet in git):')
  for (const file of written) out(`  ${path.relative(root, file)}`)
  out()
  out(`Dashboard-login:  ${options.adminUsername}  /  ${secrets.adminPassword}`)
  out('  Bewaar dit wachtwoord nu: het staat nergens leesbaar op schijf, alleen de hash.')
  out()
  out('Nog te doen:')
  out(`  1. Zet de API-sleutel van de Odoo-testgebruiker achter ODOO_API_KEY= in ${path.join(options.dir, 'gateway.env')}.`)
  out('  2. bun run local:gateway          (in een eigen terminal)')
  out('  3. bun run build && bun run local:dashboard   (in een tweede terminal)')
  out(`  4. Open http://127.0.0.1:${options.dashboardPort} en log in.`)
  if (options.responsibleId === null) {
    out()
    out('Monteur toevoegen in Odoo staat UIT: er is geen --responsible-id opgegeven.')
  } else {
    out()
    out(`Monteur toevoegen in Odoo staat AAN met Odoo-gebruiker ${options.responsibleId} als verantwoordelijke (bedrijf ${options.companyId}).`)
    out('De planningsrollen van een nieuwe monteur kies je in het dashboard, uit de rollen die in Odoo (Planning, Configuratie, Rollen) staan.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
