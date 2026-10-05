import { GatewayError } from './errors.ts'

/*
 * Which Odoo server the gateway may talk to.
 *
 * The production Odoo (Odoo.sh) must never be reached by the builder, so the
 * target host has to be listed explicitly in ODOO_ALLOWED_HOSTS, and Odoo's
 * own hosting domains are refused even when someone lists them.
 */

const FORBIDDEN_SUFFIXES = ['.odoo.sh', '.odoo.com']

export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

export function checkOdooHost(baseUrl: string, allowedHosts: readonly string[]): string {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    throw new GatewayError(500, 'invalid_odoo_url', 'ODOO_BASE_URL is not a valid URL')
  }
  if (FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) {
    throw new GatewayError(500, 'odoo_host_forbidden', `${host} is an Odoo-hosted production domain and is never allowed`)
  }
  if (allowedHosts.length === 0) {
    throw new GatewayError(500, 'odoo_host_not_allowed', 'ODOO_ALLOWED_HOSTS must list the Odoo test server')
  }
  if (!allowedHosts.includes(host)) {
    throw new GatewayError(500, 'odoo_host_not_allowed', `${host} is not in ODOO_ALLOWED_HOSTS`)
  }
  return host
}
