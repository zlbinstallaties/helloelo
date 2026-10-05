// Fixtures shared by the demo Odoo (scripts/demo-odoo.mjs) and the app probe (scripts/probe.mjs).
// Dates are relative to today so the data always has appointments for "today". The data deliberately
// contains the awkward cases that have bitten before: several visits on one appointment, a visit that
// points at a slot that was not loaded, a visit only the slot knows about, empty (false) fields, an
// unassigned appointment and visits with different statuses.

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
  // The slot lists its visit, but the visit has no slot_id of its own.
  slot(6, 'Oplevering badkamer', 0, '16:00:00', '17:00:00', 'Familie Van den Berg', 'Molenweg 4, Houten', [jan], 'published', [105], 10),
]
const visit = (id, name, offset, state, slotId, slotName, partner, tech, missing, photos) => ({
  id, name, state, visit_date: day(offset), partner_id: [100 + (slotId || id), partner], technician_id: tech,
  template_id: [1, 'Installatie'], slot_id: slotId ? [slotId, slotName] : false, task_id: false,
  is_complete: state === 'done', is_sent: false,
  missing_required_count: missing, missing_required_inputs_count: missing, photo_count: photos,
  photo_ids: Array.from({ length: photos }, (_, i) => id * 10 + i), notes: false,
})
const visits = [
  visit(100, 'TV/0001', 0, 'in_progress', 1, 'Installatie CV-ketel', 'Familie Jansen', jan, 1, 0),
  visit(101, 'TV/0002', 0, 'done', 3, 'Storing vloerverwarming', 'Mevrouw Peters', sanne, 0, 4),
  visit(102, 'TV/0003', 0, 'in_progress', 3, 'Storing vloerverwarming', 'Mevrouw Peters', sanne, 2, 1),
  visit(103, 'TV/0004', 1, 'draft', 4, 'Intake zonnepanelen', 'Garage Van Dijk', jan, 3, 0),
  // Points at a slot that is not part of the loaded set (beyond the read limit, archived, ...).
  visit(104, 'TV/0005', 2, 'draft', 99, 'Niet ingepland', 'Basisschool De Regenboog', false, 3, 0),
  visit(105, 'TV/0006', 0, 'done', 0, '', 'Familie Van den Berg', jan, 0, 6),
  // Odoo sends `false` for empty text, date and many2one fields.
  { ...visit(106, 'TV/0007', 0, 'draft', 0, '', 'Onbekend', false, 1, 0), name: false, visit_date: false, template_id: false, partner_id: false },
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

export function demoData() {
  return { 'planning.slot': slots, 'svs.tech.visit': visits }
}

export const demoFields = fields
