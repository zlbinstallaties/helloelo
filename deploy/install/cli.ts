import type { Prompts } from './prompts.ts'
import { describe as describeCaddy } from './caddy.ts'
import {
  addresses, APPLY_STEPS, gatewayRunning, inspect, InstallError, loadState, uninstall, verify, type Ctx, type Facts,
} from './steps.ts'
import type { Sys } from './sys.ts'
import {
  appsDomain, builderHost, hashPassword, liveHost, newToken, odooHost, PATHS, previewHost, randomSecret, SERVICES, validateProjectId, type InstallState,
} from './templates.ts'

/*
 * deploy/install: puts the DIG Builder on a server that already runs a Caddy web server.
 *
 *   node --experimental-strip-types --no-warnings deploy/install/main.ts check       only looks, changes nothing
 *   node --experimental-strip-types --no-warnings deploy/install/main.ts apply       installs or updates (asks first)
 *   node --experimental-strip-types --no-warnings deploy/install/main.ts status      what is running
 *   node --experimental-strip-types --no-warnings deploy/install/main.ts uninstall   removes it again [purge]
 */

export const DEFAULTS = {
  odooUrl: 'https://odoo20.srv1938209.hstgr.cloud',
  repoUrl: 'https://github.com/zlbinstallaties/helloelo.git',
  branch: 'master',
  project: { id: 'dashboard', name: 'Monteursdashboard', baseBranch: 'master' },
}

const SECRET_VALUE = /^[A-Za-z0-9._~+/=-]*$/

/** The hostname of the Odoo server without its first label: the name this server is known by. */
export function baseDomainFor(odooUrl: string) {
  return new URL(odooUrl).hostname.split('.').slice(1).join('.')
}

export function validateOdooUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Dit is geen geldig adres (verwacht: https://...).'
  }
  if (url.protocol !== 'https:') return 'Het adres moet met https:// beginnen.'
  if (/\.(odoo\.sh|odoo\.com)$/i.test(url.hostname)) return 'Dit is een Odoo.sh/odoo.com-adres. De productie-Odoo wordt nooit gekoppeld; geef de testserver.'
  if (url.hostname.split('.').length < 3) return 'Het adres van de testserver is te kort om een naam van deze server af te leiden.'
  return null
}

export interface Deps {
  sys: Sys
  prompts: Prompts
}

async function askSecret(prompts: Prompts, question: string, optional: boolean): Promise<string> {
  for (;;) {
    const value = await prompts.ask(question, { secret: true })
    if (!value && optional) return ''
    if (value && SECRET_VALUE.test(value)) return value
    prompts.say(value ? 'Dit bevat tekens die hier niet veilig kunnen worden opgeslagen (spaties, aanhalingstekens, $). Controleer of je alles goed hebt geplakt.' : 'Dit veld is verplicht.')
  }
}

async function askPassword(prompts: Prompts): Promise<string> {
  for (;;) {
    const first = await prompts.ask('Kies een wachtwoord voor de builder en de apps (minstens 12 tekens)', { secret: true })
    if (first.length < 12) {
      prompts.say('Te kort: gebruik minstens 12 tekens.')
      continue
    }
    if (first !== (await prompts.ask('Typ het nog een keer', { secret: true }))) {
      prompts.say('De twee wachtwoorden zijn niet gelijk.')
      continue
    }
    return first
  }
}

/** Asks for what is not known yet; everything already in the saved state is kept. */
export interface Source {
  repoUrl: string
  branch: string
}

export async function gatherState(deps: Deps, existing: InstallState | null, source: Source = { repoUrl: DEFAULTS.repoUrl, branch: DEFAULTS.branch }): Promise<InstallState> {
  const { prompts } = deps
  if (existing) {
    const next = { ...existing }
    if (!next.odooApiKey) next.odooApiKey = await askSecret(prompts, 'Odoo API-sleutel van de alleen-lezen testgebruiker (leeg laten = later)', true)
    if (!next.anthropicApiKey) next.anthropicApiKey = await askSecret(prompts, 'Claude API-sleutel (leeg laten = later)', true)
    return next
  }
  let odooUrl = ''
  for (;;) {
    odooUrl = (await prompts.ask('Adres van de Odoo-testserver', { default: DEFAULTS.odooUrl })).replace(/\/+$/, '')
    const problem = validateOdooUrl(odooUrl)
    if (!problem) break
    prompts.say(problem)
  }
  const baseDomain = await prompts.ask('Naam van deze server (de builder komt op bouwen.<naam>, de apps op <app>.apps.<naam>)', { default: baseDomainFor(odooUrl) })
  const odooDatabase = await prompts.ask('Naam van de Odoo-database (leeg laten als Odoo er maar één heeft)', { default: '' })
  const odooApiKey = await askSecret(prompts, 'Odoo API-sleutel van de alleen-lezen testgebruiker (leeg laten = later)', true)
  const anthropicApiKey = await askSecret(prompts, 'Claude API-sleutel voor de bouwagent (leeg laten = later)', true)
  const password = await askPassword(prompts)
  const project = { ...DEFAULTS.project, repoUrl: source.repoUrl, baseBranch: source.branch }
  if (!validateProjectId(project.id)) throw new InstallError(`ongeldig project-id ${project.id}`)
  return {
    version: 1,
    baseDomain,
    odooUrl,
    odooDatabase,
    odooApiKey,
    anthropicApiKey,
    repoUrl: source.repoUrl,
    branch: source.branch,
    projects: [project],
    passwordHash: hashPassword(password),
    previewSessionSecret: randomSecret(),
    builderSessionSecret: randomSecret(),
    devToken: newToken(),
    liveToken: newToken(),
  }
}

async function dnsProblems(sys: Sys, state: InstallState, facts: Facts): Promise<string[]> {
  const hosts = [builderHost(state), ...state.projects.flatMap((p) => [previewHost(state, p.id), liveHost(state, p.id)])]
  const problems: string[] = []
  for (const host of hosts) {
    const resolved = await sys.run('getent', ['ahostsv4', host])
    const ips = new Set(resolved.stdout.split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean))
    if (!ips.size) problems.push(`${host} bestaat niet in DNS`)
    else if (facts.publicIp && !ips.has(facts.publicIp)) problems.push(`${host} wijst naar ${[...ips].join(', ')}, niet naar deze server (${facts.publicIp})`)
  }
  return problems
}

function describePlan(state: InstallState, facts: Facts) {
  const a = addresses(state)
  return [
    'Dit gaat er gebeuren (de Odoo-testserver en alles wat al op de server draait blijft ongemoeid):',
    `  - systeemgebruiker dig-builder, mappen ${PATHS.root} en ${PATHS.etc}`,
    `  - code van ${state.repoUrl} (${state.branch}) naar ${PATHS.app}, en project ${state.projects.map((p) => p.id).join(', ')} naar ${PATHS.apps}`,
    '  - Docker: sandbox-afbeelding bouwen, intern netwerk dig-preview, Odoo-gateway (alleen-lezen, geen poort naar buiten)',
    '  - twee diensten: dig-preview (poort 8090) en dig-builder-app (poort 8100). Ze luisteren alleen op localhost van de server, dus niet vanaf internet',
    `  - de bestaande Caddy (${facts.caddy ? describeCaddy(facts.caddy) : 'onbekend'}) krijgt één blok met onze adressen onderaan het Caddyfile, tussen de regels BEGIN en END DIG Builder. Eerst een reservekopie, dan controle door Caddy zelf, dan laden zonder onderbreking; de Odoo-testserver wordt voor en na gecontroleerd`,
    '',
    'Daarna bereikbaar op:',
    `  - builder:   ${a.builder}`,
    ...a.projects.flatMap((p) => [`  - preview:   ${p.preview}`, `  - gepubliceerd: ${p.live}`]),
  ].join('\n')
}

export async function check(deps: Deps): Promise<number> {
  const { sys, prompts } = deps
  const facts = await inspect(sys)
  prompts.say(`Systeem:        ${facts.os}, Node ${process.version}`)
  prompts.say(`Docker:         ${facts.docker ? 'ja' : 'nee'}, compose: ${facts.compose ? 'ja' : 'nee'}`)
  prompts.say(`Caddy:          ${facts.caddy ? describeCaddy(facts.caddy) : 'niet gevonden'}`)
  prompts.say(`Publiek IP:     ${facts.publicIp ?? 'onbekend'}`)
  const state = await loadState(sys)
  prompts.say(`Eerder geïnstalleerd: ${state ? 'ja' : 'nee'}`)
  const base = state?.baseDomain ?? baseDomainFor(DEFAULTS.odooUrl)
  const sample = { ...({} as InstallState), baseDomain: base, projects: state?.projects ?? [{ ...DEFAULTS.project, repoUrl: DEFAULTS.repoUrl }] } as InstallState
  const dns = await dnsProblems(sys, sample, facts)
  prompts.say(`DNS:            ${dns.length ? dns.join('; ') : `alle namen onder ${base} wijzen naar deze server`}`)
  if (facts.problems.length) {
    prompts.say(`\nDit moet eerst opgelost worden:\n${facts.problems.map((p) => `  - ${p}`).join('\n')}`)
    return 1
  }
  prompts.say('\nAlles ziet er goed uit om te installeren. Er is niets veranderd.')
  return 0
}

export async function apply(deps: Deps, options: { yes?: boolean; source?: Source; waitSeconds?: number } = {}): Promise<number> {
  const { sys, prompts } = deps
  const facts = await inspect(sys)
  if (facts.problems.length) {
    prompts.say(`Installeren kan nog niet:\n${facts.problems.map((p) => `  - ${p}`).join('\n')}`)
    return 1
  }
  const state = await gatherState(deps, await loadState(sys), options.source)
  prompts.say(`\n${describePlan(state, facts)}\n`)
  const dns = await dnsProblems(sys, state, facts)
  if (dns.length) {
    prompts.say(`Let op, Caddy kan geen certificaat krijgen zolang dit niet klopt:\n${dns.map((d) => `  - ${d}`).join('\n')}\n`)
  }
  if (!options.yes && !(await prompts.confirm('Doorgaan?'))) {
    prompts.say('Gestopt. Er is niets veranderd.')
    return 1
  }
  const ctx: Ctx = { sys, state, facts }
  for (const [index, step] of APPLY_STEPS.entries()) {
    prompts.say(`[${index + 1}/${APPLY_STEPS.length}] ${step.title} ...`)
    try {
      prompts.say(`      ${await step.run(ctx)}`)
    } catch (error) {
      prompts.say(`\nMislukt bij "${step.title}": ${error instanceof Error ? error.message : String(error)}`)
      if (error instanceof InstallError && error.hint) prompts.say(error.hint)
      prompts.say('\nDe stappen die al klaar zijn blijven staan. Je kunt het script opnieuw uitvoeren: het slaat over wat al gedaan is.')
      return 1
    }
  }
  prompts.say('\nControle van de adressen (een nieuw adres kan tot een minuut nodig hebben voor het certificaat) ...')
  const checks = await verify(sys, state, (options.waitSeconds ?? 120) * 1000)
  for (const c of checks) prompts.say(`  ${c.ok ? 'ok     ' : 'FOUT   '} ${c.name}: ${c.status ?? 'geen antwoord'}  ${c.url}`)
  const a = addresses(state)
  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    prompts.say(`\nGeïnstalleerd, maar ${failed.length === checks.length ? 'geen enkel adres' : 'niet elk adres'} antwoordt al. Meestal is een nieuw certificaat nog onderweg: wacht een minuut en draai "status".`)
    prompts.say('Blijft het fout? Kijk met: journalctl -u caddy -n 50 --no-pager   en   journalctl -u dig-builder-app -n 50 --no-pager')
  } else {
    prompts.say(`\nKlaar. Open ${a.builder} en log in met het wachtwoord dat je net koos.`)
  }
  if (!state.odooApiKey) prompts.say('Er is nog geen Odoo-sleutel ingesteld, dus de apps tonen geen gegevens. Voer het script opnieuw uit zodra je die hebt.')
  if (!state.anthropicApiKey) prompts.say('Er is nog geen Claude-sleutel ingesteld, dus de bouwagent kan nog niet werken. Voer het script opnieuw uit zodra je die hebt.')
  return checks.every((c) => c.ok) ? 0 : 2
}

export async function status(deps: Deps): Promise<number> {
  const { sys, prompts } = deps
  const state = await loadState(sys)
  if (!state) {
    prompts.say('Er is hier nog niets geïnstalleerd.')
    return 1
  }
  for (const name of SERVICES) prompts.say(`${name.padEnd(18)} ${(await sys.run('systemctl', ['is-active', name])).stdout.trim() || 'onbekend'}`)
  prompts.say(`${'odoo-gateway'.padEnd(18)} ${(await gatewayRunning(sys)) ? 'active' : 'niet actief'}`)
  const live = await sys.run('docker', ['ps', '--filter', 'label=dig.live', '--format', '{{.Names}} ({{.Status}})'])
  prompts.say(`gepubliceerde apps: ${live.stdout.trim().replace(/\n/g, ', ') || 'geen'}`)
  const a = addresses(state)
  prompts.say(`\nbuilder: ${a.builder}\nOdoo:    ${odooHost(state)}  |  apps-domein: ${appsDomain(state)}`)
  const checks = await verify(sys, state, 0)
  for (const c of checks) prompts.say(`  ${c.ok ? 'ok   ' : 'FOUT '} ${c.name}: ${c.status ?? 'geen antwoord'}`)
  return checks.every((c) => c.ok) ? 0 : 2
}

export async function remove(deps: Deps, purge: boolean): Promise<number> {
  const { sys, prompts } = deps
  const facts = await inspect(sys)
  prompts.say(purge
    ? `Dit verwijdert de diensten, de gepubliceerde apps, de Caddy-aanvulling, de code, alle gegevens en geheimen (${PATHS.root}, ${PATHS.etc}) en de gebruiker dig-builder.`
    : 'Dit verwijdert de diensten, de gepubliceerde apps en de Caddy-aanvulling. Code, gegevens en geheimen blijven staan.')
  prompts.say('De Odoo-testserver en andere containers worden niet aangeraakt.')
  if (!(await prompts.confirm('Doorgaan?'))) return 1
  try {
    for (const line of await uninstall(sys, facts, { purge })) prompts.say(`  - ${line}`)
  } catch (error) {
    prompts.say(`Mislukt: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  return 0
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'check':
      return check(deps)
    case 'apply': {
      // --repo and --branch are for trying a change before it is on the main branch.
      const value = (flag: string) => rest[rest.indexOf(flag) + 1]
      const source = { repoUrl: rest.includes('--repo') ? value('--repo') : DEFAULTS.repoUrl, branch: rest.includes('--branch') ? value('--branch') : DEFAULTS.branch }
      return apply(deps, { yes: rest.includes('--yes'), source, waitSeconds: rest.includes('--wait') ? Number(value('--wait')) : undefined })
    }
    case 'status':
      return status(deps)
    case 'uninstall':
      return remove(deps, rest.includes('purge') || rest.includes('--purge'))
    default:
      deps.prompts.say('Gebruik: main.ts check | apply | status | uninstall [purge]')
      return 64
  }
}
