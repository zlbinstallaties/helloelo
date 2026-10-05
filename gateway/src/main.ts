import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createOdooClient } from '../../src/lib/odoo-client.ts'
import { allModels, parseProjects } from './projects.ts'
import { createGateway } from './server.ts'

/*
 * Entry point. Server secrets come from the environment and stay here:
 *   ODOO_BASE_URL, ODOO_API_KEY, ODOO_DATABASE (optional)
 *   GATEWAY_PROJECTS_FILE  JSON with per-project allowlists and token hashes
 *   GATEWAY_PORT           default 8070
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} must be set`)
    process.exit(1)
  }
  return value
}

const projects = parseProjects(JSON.parse(readFileSync(required('GATEWAY_PROJECTS_FILE'), 'utf8')))
const odoo = createOdooClient({
  baseUrl: required('ODOO_BASE_URL'),
  apiKey: required('ODOO_API_KEY'),
  database: process.env.ODOO_DATABASE || undefined,
  allowedModels: allModels(projects),
})

const port = Number(process.env.GATEWAY_PORT ?? 8070)
const server = createServer(createGateway({ projects, odoo }))
server.requestTimeout = 30_000
server.listen(port, () => {
  console.log(JSON.stringify({ event: 'listening', port, projects: projects.map((p) => p.id) }))
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
