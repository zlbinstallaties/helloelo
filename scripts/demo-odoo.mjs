// Demo Odoo for trial runs: a tiny stand-in for the Odoo JSON-2 API with sample
// data for planning.slot and svs.tech.visit. NOT a real Odoo; no auth beyond a
// non-empty bearer token. Usage: node scripts/demo-odoo.mjs   (port 18069)
import { createServer } from 'node:http'
import { demoData, demoFields } from './demo-data.mjs'

const data = demoData()
const fields = demoFields

createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const [, , , model, method] = new URL(req.url, 'http://x').pathname.split('/')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (!/^bearer .+/i.test(req.headers.authorization ?? '')) return send(401, { name: 'odoo.exceptions.AccessDenied', message: 'no key' })
  if (!data[model]) return send(404, { name: 'odoo.exceptions.MissingError', message: 'unknown model' })
  const body = raw ? JSON.parse(raw) : {}
  if (method === 'fields_get') return send(200, fields[model])
  if (method === 'search_count') return send(200, data[model].length)
  if (method === 'search_read') {
    const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : Object.keys(fields[model])
    const rows = data[model].slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 80))
    return send(200, rows.map((row) => Object.fromEntries(wanted.filter((f) => f in row).map((f) => [f, row[f]]))))
  }
  return send(404, { name: 'odoo.exceptions.MissingError', message: 'unknown method' })
}).listen(Number(process.env.DEMO_ODOO_PORT ?? 18069), '127.0.0.1', () => console.error('demo odoo on', process.env.DEMO_ODOO_PORT ?? 18069))
