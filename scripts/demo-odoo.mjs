// Demo Odoo for trial runs: a tiny stand-in for the Odoo JSON-2 API with sample
// data for planning.slot and svs.tech.visit. NOT a real Odoo; no auth beyond a
// non-empty bearer token. Usage: node scripts/demo-odoo.mjs   (port 18069)
import { createServer } from 'node:http'

const day = (offset) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const at = (offset, time) => `${day(offset)} ${time}`

const jan = [5, 'Jan de Vries']
const sanne = [6, 'Sanne Bakker']
const slot = (id, name, offset, from, to, partner, address, people, state, visits, travel) => ({
  id, name, start_datetime: at(offset, from), end_datetime: at(offset, to), allocated_hours: 3,
  role_id: [1, 'Monteur'], user_ids: people, employee_ids: people,
  partner_id: [100 + id, partner], partner_name: partner, partner_address: address,
  sale_order_id: false, sale_line_id: false, state, svs_tech_visit_ids: visits,
  travel_time_in: travel, travel_time_out: travel, travel_times_up_to_date: travel > 0,
})
const slots = [
  slot(1, 'Installatie CV-ketel', 0, '07:00:00', '10:00:00', 'Familie Jansen', 'Kerkstraat 12, Utrecht', [jan], 'published', [100], 20),
  slot(2, 'Onderhoud warmtepomp', 0, '11:00:00', '12:30:00', 'Bakkerij Smit', 'Dorpsplein 3, Amersfoort', [], 'draft', [], 0),
  // Two visits on one appointment: the dashboard currently shows only one of them.
  slot(3, 'Storing vloerverwarming', 0, '13:00:00', '15:00:00', 'Mevrouw Peters', 'Lindelaan 8, Zeist', [sanne], 'published', [101, 102], 15),
  slot(4, 'Intake zonnepanelen', 1, '09:00:00', '10:30:00', 'Garage Van Dijk', 'Industrieweg 21, Nieuwegein', [jan, sanne], 'published', [103], 25),
  slot(5, 'Keuring gasinstallatie', 3, '08:00:00', '09:30:00', 'Kantoor Hoekstra', 'Stationsplein 1, Utrecht', [sanne], 'draft', [], 0),
]
const visit = (id, name, offset, state, slotId, slotName, partner, tech, missing, photos) => ({
  id, name, state, visit_date: day(offset), partner_id: [100 + slotId, partner], technician_id: tech,
  template_id: [1, 'Installatie'], slot_id: [slotId, slotName], task_id: false,
  is_complete: state === 'done', is_sent: false,
  missing_required_count: missing, missing_required_inputs_count: missing, photo_count: photos,
  photo_ids: Array.from({ length: photos }, (_, i) => id * 10 + i), notes: false,
})
const visits = [
  visit(100, 'TV/0001', 0, 'in_progress', 1, 'Installatie CV-ketel', 'Familie Jansen', jan, 1, 0),
  visit(101, 'TV/0002', 0, 'done', 3, 'Storing vloerverwarming', 'Mevrouw Peters', sanne, 0, 4),
  visit(102, 'TV/0003', 0, 'in_progress', 3, 'Storing vloerverwarming', 'Mevrouw Peters', sanne, 2, 1),
  visit(103, 'TV/0004', 1, 'draft', 4, 'Intake zonnepanelen', 'Garage Van Dijk', jan, 3, 0),
  visit(104, 'TV/0005', 2, 'draft', 99, 'Niet ingepland', 'Basisschool De Regenboog', false, 3, 0),
]

const F = (type, string, relation) => ({ type, string, ...(relation ? { relation } : {}) })
const fields = {
  'planning.slot': {
    id: F('integer', 'ID'), name: F('char', 'Omschrijving'), start_datetime: F('datetime', 'Start'),
    end_datetime: F('datetime', 'Einde'), allocated_hours: F('float', 'Toegewezen uren'),
    role_id: F('many2one', 'Rol', 'planning.role'), user_ids: F('many2many', 'Gebruikers', 'res.users'),
    employee_ids: F('many2many', 'Medewerkers', 'hr.employee'), partner_id: F('many2one', 'Klant', 'res.partner'),
    partner_name: F('char', 'Klantnaam'), partner_address: F('char', 'Adres'),
    sale_order_id: F('many2one', 'Verkooporder', 'sale.order'), sale_line_id: F('many2one', 'Orderregel', 'sale.order.line'),
    state: F('selection', 'Status'), svs_tech_visit_ids: F('one2many', 'Bezoeken', 'svs.tech.visit'),
    travel_time_in: F('integer', 'Reistijd heen'), travel_time_out: F('integer', 'Reistijd terug'),
    travel_times_up_to_date: F('boolean', 'Reistijden actueel'),
  },
  'svs.tech.visit': {
    id: F('integer', 'ID'), name: F('char', 'Bezoek'), state: F('selection', 'Status'),
    visit_date: F('date', 'Bezoekdatum'), partner_id: F('many2one', 'Klant', 'res.partner'),
    technician_id: F('many2one', 'Technicus', 'res.users'), template_id: F('many2one', 'Sjabloon', 'svs.tech.template'),
    slot_id: F('many2one', 'Planning', 'planning.slot'), task_id: F('many2one', 'Taak', 'project.task'),
    is_complete: F('boolean', 'Compleet'), is_sent: F('boolean', 'Verzonden'),
    missing_required_count: F('integer', 'Ontbrekende verplichte onderdelen'),
    missing_required_inputs_count: F('integer', 'Ontbrekende verplichte invoer'),
    photo_count: F('integer', "Foto's"), photo_ids: F('one2many', "Foto's", 'ir.attachment'), notes: F('text', 'Notities'),
  },
}
const data = { 'planning.slot': slots, 'svs.tech.visit': visits }

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
