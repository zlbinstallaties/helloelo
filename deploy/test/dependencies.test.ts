import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

const root = path.join(import.meta.dirname, '../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (name === 'node_modules') return []
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|mjs|js)$/.test(name) ? [full] : []
  })
}

/** Packages (not relative paths, not node: built-ins) that a file imports. */
function importedPackages(file: string) {
  const text = readFileSync(file, 'utf8')
  const found = new Set<string>()
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('#') || specifier.startsWith('/')) continue
    if (builtinModules.includes(specifier.split('/')[0])) continue
    found.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
  }
  return found
}

// What the installer puts on the server: the code the two services and the gateway load. Only the agent
// library has packages of its own, installed from agent/bun.lock. If this fails, the installer must learn
// to install the new package, or the service will not start (that is how it was found on a rehearsal).
test('everything the server-side code imports is installed by the installer', () => {
  const agent = JSON.parse(readFileSync(path.join(root, 'agent/package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const installed = new Set(Object.keys(agent.dependencies))
  const dirs = ['builder-app/src', 'sandbox/src', 'gateway/src', 'agent/src', 'deploy/install']
  const offenders: string[] = []
  for (const dir of dirs) {
    for (const file of sourceFiles(path.join(root, dir))) {
      for (const pkg of importedPackages(file)) if (!installed.has(pkg)) offenders.push(`${path.relative(root, file)} imports ${pkg}`)
    }
  }
  for (const file of ['src/lib/odoo-client.ts']) {
    for (const pkg of importedPackages(path.join(root, file))) if (!installed.has(pkg)) offenders.push(`${file} imports ${pkg}`)
  }
  assert.deepEqual(offenders, [])
  assert.ok(installed.has('@anthropic-ai/sdk') && installed.has('zod'), 'the scan did see the agent packages')
})

test('the scanner itself finds imports of all kinds', () => {
  const dir = path.join(root, 'agent/src')
  const all = new Set(sourceFiles(dir).flatMap((f) => [...importedPackages(f)]))
  assert.ok(all.has('@anthropic-ai/sdk'))
  assert.ok(all.has('zod'))
  assert.ok(![...all].some((p) => p.startsWith('node:') || p.startsWith('.')))
})
