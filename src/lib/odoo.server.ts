import '@tanstack/react-start/server-only'
import { env } from '@helloleo/runtime'
import { createOdooClient, type OdooClient } from '#/lib/odoo-client'

/*
 * Wiring for the standalone Odoo client. SERVER-ONLY.
 *
 * Required env (server secrets, never in browser code):
 *   ODOO_BASE_URL   https://<your-odoo-host>
 *   ODOO_API_KEY    API key of a dedicated read-only Odoo user
 * Optional:
 *   ODOO_DATABASE   X-Odoo-Database header (multi-database servers)
 *
 * Returns null when not configured, so callers can fall back to the
 * HelloLeo proxy while migrating.
 */

export const ODOO_ALLOWED_MODELS = ['planning.slot', 'svs.tech.visit'] as const

function readEnv(name: string): string | undefined {
  const fromRuntime = (env as unknown as Record<string, string | undefined>)[name]
  if (fromRuntime) return fromRuntime
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

let cached: OdooClient | null | undefined

export function getOdooClient(): OdooClient | null {
  if (cached !== undefined) return cached
  const baseUrl = readEnv('ODOO_BASE_URL')
  const apiKey = readEnv('ODOO_API_KEY')
  cached =
    baseUrl && apiKey
      ? createOdooClient({
          baseUrl,
          apiKey,
          database: readEnv('ODOO_DATABASE'),
          allowedModels: ODOO_ALLOWED_MODELS,
        })
      : null
  return cached
}
