// Demo Odoo for trial runs: a tiny stand-in for the Odoo JSON-2 API with sample
// data for planning.slot and svs.tech.visit, and just enough of res.users and
// hr.employee to rehearse "add a technician" (see docs/lokaal-testen.md).
// NOT a real Odoo; no auth beyond a non-empty bearer token.
// Usage: node scripts/demo-odoo.mjs   (port 18069, DEMO_ODOO_PORT to change)
//
// `hr.employee/write` understands only the two planning-role fields (all the dashboard ever changes); anything else is an error.
// `resource.calendar.leaves` (a period in which one employee is not available) can be created, read by id and removed.
// `ir.attachment/create` and `res.partner/message_post` take a signed document: the file goes on a customer (the `partner_id` of a
// planning.slot or svs.tech.visit of the sample data) and an internal note without recipients points at it. Both are logged as
// ATTACH and NOTE. `planning.slot` and `svs.tech.visit` can be read by id.
//
// The employee part follows what the Odoo 20.0 source says: `create` takes `vals_list` and answers with the
// new ids, a many2one comes back as [id, name] or false, a many2many as a list of ids, and an unknown field
// is an error. It does not do what Odoo does around a create (work contact, resource, chatter note); it only
// logs that, so a rehearsal shows what a real Odoo would add.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { demoData, demoFields } from './demo-data.mjs'

const EMPLOYEE_FIELDS = ['name', 'company_id', 'hr_responsible_id', 'user_id', 'date_version', 'planning_role_ids', 'default_planning_role_id']
const COMPANY_NAME = 'Demo bedrijf'
const CALENDAR = [1, 'Standaard 40 uur']
// The resource of an employee has an id of its own, as in Odoo.
const resourceIdOf = (employeeId) => 5000 + employeeId
// res.users the rehearsal can use as responsible: 2 is a valid choice, the others are not.
const USERS = [
  { id: 2, active: true, share: false, company_ids: [1, 2] },
  { id: 3, active: true, share: true, company_ids: [1, 2] },
  { id: 4, active: false, share: false, company_ids: [1, 2] },
  { id: 5, active: true, share: false, company_ids: [2] },
  { id: 6, active: true, share: false, company_ids: [2] },
]

// planning.role records: 1 and 2 can be used, 3 is archived (Odoo then does not find it by default).
const ROLES = [
  { id: 1, name: 'Monteur', active: true },
  { id: 2, name: 'Planner', active: true },
  { id: 3, name: 'Oud', active: false },
]

const ATTACHMENT_FIELDS = ['name', 'type', 'datas', 'mimetype', 'res_model', 'res_id']
const NOTE_ARGUMENTS = ['ids', 'body', 'message_type', 'subtype_xmlid', 'attachment_ids', 'context']

const odooError = (name, message) => ({ name, message, arguments: [message], context: {}, debug: '' })
const idFilter = (domain) => (Array.isArray(domain) && domain.length >= 1 && Array.isArray(domain[0]) && domain[0][0] === 'id' && domain[0][1] === '=' ? domain[0][2] : null)
const pick = (row, wanted) => Object.fromEntries(wanted.filter((field) => field in row).map((field) => [field, row[field]]))

/** `log` gets one line per write. `employees` is the in-memory hr.employee table, for tests. */
export function createDemoOdoo({ log = () => {} } = {}) {
  const data = demoData()
  const employees = []
  const leaves = []
  const attachments = []
  const notes = []
  let nextEmployeeId = 900
  let nextLeaveId = 7000
  let nextAttachmentId = 8000
  let nextNoteId = 9000
  // The customers (res.partner) of the sample data: the many2one `partner_id` of the slots and visits.
  const partners = new Map()
  for (const rows of Object.values(data)) {
    for (const row of rows) if (Array.isArray(row.partner_id)) partners.set(row.partner_id[0], row.partner_id[1])
  }

  function employeeRow(employee) {
    return {
      id: employee.id,
      name: employee.name,
      company_id: [employee.companyId, COMPANY_NAME],
      user_id: employee.userId ? [employee.userId, 'Gebruiker'] : false,
      planning_role_ids: [...employee.roleIds],
      default_planning_role_id: employee.defaultRoleId ? [employee.defaultRoleId, ROLES.find((role) => role.id === employee.defaultRoleId)?.name ?? ''] : false,
      active: true,
      resource_id: [resourceIdOf(employee.id), employee.name],
      resource_calendar_id: CALENDAR,
      tz: 'Europe/Amsterdam',
      hr_responsible_id: [employee.responsibleId, 'Verantwoordelijke'],
      date_version: employee.dateVersion,
    }
  }

  function handle(model, method, body) {
    if (model === 'res.users' && method === 'search_read') {
      const id = idFilter(body.domain)
      const activeTest = body.context?.active_test !== false
      const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : ['id', 'active', 'share', 'company_ids']
      return [200, USERS.filter((user) => user.id === id && (user.active || !activeTest)).map((user) => pick(user, wanted))]
    }
    if (model === 'planning.role' && method === 'search_read') {
      // An empty domain is the list of roles; a domain on the id is the check of chosen ids.
      const everything = !Array.isArray(body.domain) || body.domain.length === 0
      const asked = body.domain?.[0]?.[2]
      const activeTest = body.context?.active_test !== false
      const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : ['id', 'name']
      const rows = ROLES.filter((role) => (everything || (Array.isArray(asked) && asked.includes(role.id))) && (role.active || !activeTest))
      if (everything) rows.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
      return [200, rows.map((role) => pick(role, wanted))]
    }
    if (model === 'hr.employee' && method === 'search_read') {
      const id = idFilter(body.domain)
      const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : ['id', 'name', 'company_id', 'user_id', 'active']
      return [200, employees.filter((employee) => employee.id === id).map((employee) => pick(employeeRow(employee), wanted))]
    }
    if (model === 'hr.employee' && method === 'create') {
      if (!Array.isArray(body.vals_list)) return [422, odooError('builtins.TypeError', "create() missing 1 required positional argument: 'vals_list'")]
      const allowedCompanies = body.context?.allowed_company_ids
      if (!Array.isArray(allowedCompanies) || allowedCompanies.length === 0) return [500, odooError('builtins.ValueError', 'the rehearsal needs allowed_company_ids in the context')]
      const created = []
      for (const vals of body.vals_list) {
        for (const field of Object.keys(vals)) {
          if (!EMPLOYEE_FIELDS.includes(field)) return [500, odooError('builtins.ValueError', `Invalid field '${field}' in 'hr.employee'`)]
        }
        if (typeof vals.name !== 'string' || !vals.name.trim()) return [500, odooError('odoo.exceptions.ValidationError', 'name is required')]
        if (!allowedCompanies.includes(vals.company_id)) return [403, odooError('odoo.exceptions.AccessError', 'Access to unauthorized or invalid companies.')]
        const user = USERS.find((candidate) => candidate.id === vals.hr_responsible_id)
        if (!user) return [500, odooError('odoo.exceptions.ValidationError', 'hr_responsible_id does not exist')]
        // planning_role_ids is an Odoo "set" command: [[6, 0, [ids]]]. A role that does not exist or is archived is refused.
        let roleIds = []
        if (vals.planning_role_ids !== undefined) {
          const command = vals.planning_role_ids
          if (!Array.isArray(command) || command.length !== 1 || !Array.isArray(command[0]) || command[0][0] !== 6 || command[0][1] !== 0 || !Array.isArray(command[0][2])) {
            return [500, odooError('builtins.ValueError', 'planning_role_ids: the rehearsal only understands [[6, 0, [ids]]]')]
          }
          roleIds = command[0][2]
          if (roleIds.some((id) => !ROLES.some((role) => role.id === id && role.active))) return [500, odooError('odoo.exceptions.MissingError', 'a planning role does not exist or is archived')]
        }
        if (vals.default_planning_role_id !== undefined && vals.default_planning_role_id !== false && !roleIds.includes(vals.default_planning_role_id)) {
          return [500, odooError('odoo.exceptions.ValidationError', 'the default planning role must be one of the roles')]
        }
        const employee = {
          roleIds,
          defaultRoleId: vals.default_planning_role_id || null,
          id: nextEmployeeId++,
          name: vals.name,
          companyId: vals.company_id,
          userId: vals.user_id || null,
          responsibleId: vals.hr_responsible_id,
          dateVersion: vals.date_version ?? null,
        }
        employees.push(employee)
        created.push(employee.id)
        log(`CREATE hr.employee ${JSON.stringify(vals)} -> id ${employee.id}`)
        log('  (a real Odoo 20 also adds: a resource, a first hr.version, a work contact res.partner without login, an internal onboarding note)')
      }
      return [200, created]
    }
    if (model === 'hr.employee' && method === 'write') {
      const allowedCompanies = body.context?.allowed_company_ids
      if (!Array.isArray(allowedCompanies) || allowedCompanies.length === 0) return [500, odooError('builtins.ValueError', 'the rehearsal needs allowed_company_ids in the context')]
      if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.vals || typeof body.vals !== 'object' || Array.isArray(body.vals)) {
        return [422, odooError('builtins.TypeError', "write() missing required arguments 'ids' and 'vals'")]
      }
      const targets = body.ids.map((id) => employees.find((employee) => employee.id === id))
      if (targets.some((employee) => !employee)) return [404, odooError('odoo.exceptions.MissingError', 'Record does not exist or has been deleted.')]
      for (const field of Object.keys(body.vals)) {
        if (!['planning_role_ids', 'default_planning_role_id'].includes(field)) return [500, odooError('builtins.ValueError', `the rehearsal only writes the planning role fields, not '${field}'`)]
      }
      let roleIds = null
      if (body.vals.planning_role_ids !== undefined) {
        const command = body.vals.planning_role_ids
        if (!Array.isArray(command) || command.length !== 1 || !Array.isArray(command[0]) || command[0][0] !== 6 || command[0][1] !== 0 || !Array.isArray(command[0][2])) {
          return [500, odooError('builtins.ValueError', 'planning_role_ids: the rehearsal only understands [[6, 0, [ids]]]')]
        }
        roleIds = command[0][2]
        if (roleIds.some((id) => !ROLES.some((role) => role.id === id && role.active))) return [500, odooError('odoo.exceptions.MissingError', 'a planning role does not exist or is archived')]
      }
      const defaultRole = body.vals.default_planning_role_id
      if (defaultRole !== undefined && defaultRole !== false && !(roleIds ?? targets.flatMap((employee) => employee.roleIds)).includes(defaultRole)) {
        return [500, odooError('odoo.exceptions.ValidationError', 'the default planning role must be one of the roles')]
      }
      for (const employee of targets) {
        if (roleIds !== null) employee.roleIds = [...roleIds]
        if (defaultRole !== undefined) employee.defaultRoleId = defaultRole || null
        else if (roleIds !== null && !roleIds.includes(employee.defaultRoleId)) employee.defaultRoleId = null
      }
      log(`WRITE hr.employee ${JSON.stringify(body.ids)} ${JSON.stringify(body.vals)}`)
      return [200, true]
    }
    if (model === 'resource.calendar.leaves') {
      const dateTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
      const row = (leave) => ({
        id: leave.id,
        name: leave.name,
        resource_id: leave.resourceId ? [leave.resourceId, employees.find((employee) => resourceIdOf(employee.id) === leave.resourceId)?.name ?? ''] : false,
        calendar_id: leave.calendarId ? CALENDAR : false,
        date_from: leave.dateFrom,
        date_to: leave.dateTo,
      })
      if (method === 'create') {
        if (!Array.isArray(body.vals_list)) return [422, odooError('builtins.TypeError', "create() missing 1 required positional argument: 'vals_list'")]
        const created = []
        for (const vals of body.vals_list) {
          for (const field of Object.keys(vals)) {
            if (!['name', 'resource_id', 'calendar_id', 'date_from', 'date_to'].includes(field)) return [500, odooError('builtins.ValueError', `Invalid field '${field}' in 'resource.calendar.leaves'`)]
          }
          if (!employees.some((employee) => resourceIdOf(employee.id) === vals.resource_id)) return [500, odooError('odoo.exceptions.MissingError', 'the resource does not exist')]
          if (vals.calendar_id !== undefined && vals.calendar_id !== CALENDAR[0]) return [500, odooError('odoo.exceptions.MissingError', 'the working schedule does not exist')]
          if (typeof vals.name !== 'string' || !vals.name.trim()) return [500, odooError('odoo.exceptions.ValidationError', 'name is required')]
          if (!dateTime.test(vals.date_from ?? '') || !dateTime.test(vals.date_to ?? '')) return [500, odooError('builtins.ValueError', 'date_from and date_to must be YYYY-MM-DD HH:MM:SS')]
          if (vals.date_from >= vals.date_to) return [500, odooError('odoo.exceptions.ValidationError', 'The start date must be earlier than the end date.')]
          const leave = { id: nextLeaveId++, name: vals.name, resourceId: vals.resource_id, calendarId: vals.calendar_id ?? null, dateFrom: vals.date_from, dateTo: vals.date_to }
          leaves.push(leave)
          created.push(leave.id)
          log(`CREATE resource.calendar.leaves ${JSON.stringify(vals)} -> id ${leave.id}`)
        }
        return [200, created]
      }
      if (method === 'search_read') {
        const id = idFilter(body.domain)
        const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : ['id', 'name']
        return [200, leaves.filter((leave) => leave.id === id).map((leave) => pick(row(leave), wanted))]
      }
      if (method === 'unlink') {
        if (!Array.isArray(body.ids) || body.ids.length === 0) return [422, odooError('builtins.TypeError', "unlink() needs 'ids'")]
        if (body.ids.some((id) => !leaves.some((leave) => leave.id === id))) return [404, odooError('odoo.exceptions.MissingError', 'Record does not exist or has been deleted.')]
        for (const id of body.ids) leaves.splice(leaves.findIndex((leave) => leave.id === id), 1)
        log(`UNLINK resource.calendar.leaves ${JSON.stringify(body.ids)}`)
        return [200, true]
      }
      return [404, odooError('odoo.exceptions.MissingError', 'unknown method')]
    }
    if (model === 'ir.attachment' && method === 'create') {
      if (!Array.isArray(body.vals_list)) return [422, odooError('builtins.TypeError', "create() missing 1 required positional argument: 'vals_list'")]
      const allowedCompanies = body.context?.allowed_company_ids
      if (!Array.isArray(allowedCompanies) || allowedCompanies.length === 0) return [500, odooError('builtins.ValueError', 'the rehearsal needs allowed_company_ids in the context')]
      const created = []
      for (const vals of body.vals_list) {
        for (const field of Object.keys(vals)) {
          if (!ATTACHMENT_FIELDS.includes(field)) return [500, odooError('builtins.ValueError', `Invalid field '${field}' in 'ir.attachment'`)]
        }
        if (vals.res_model !== 'res.partner' || !partners.has(vals.res_id)) return [500, odooError('odoo.exceptions.MissingError', 'the rehearsal attaches files to a customer of the sample data only')]
        if (typeof vals.name !== 'string' || !vals.name.trim()) return [500, odooError('odoo.exceptions.ValidationError', 'name is required')]
        if (typeof vals.datas !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(vals.datas)) return [500, odooError('builtins.ValueError', 'datas must be base64')]
        const bytes = Buffer.from(vals.datas, 'base64')
        const attachment = { id: nextAttachmentId++, name: vals.name, type: vals.type ?? 'binary', mimetype: vals.mimetype ?? null, resModel: vals.res_model, resId: vals.res_id, bytes }
        attachments.push(attachment)
        created.push(attachment.id)
        log(`ATTACH ir.attachment ${attachment.id} "${attachment.name}" (${bytes.length} bytes) on res.partner ${attachment.resId} (${partners.get(attachment.resId)}) starts with ${JSON.stringify(bytes.subarray(0, 5).toString('latin1'))}`)
      }
      return [200, created]
    }
    if (model === 'res.partner' && method === 'message_post') {
      for (const argument of Object.keys(body)) {
        if (!NOTE_ARGUMENTS.includes(argument)) return [422, odooError('builtins.TypeError', `message_post() got an unexpected keyword argument '${argument}'`)]
      }
      const allowedCompanies = body.context?.allowed_company_ids
      if (!Array.isArray(allowedCompanies) || allowedCompanies.length === 0) return [500, odooError('builtins.ValueError', 'the rehearsal needs allowed_company_ids in the context')]
      if (!Array.isArray(body.ids) || body.ids.length !== 1 || !partners.has(body.ids[0])) return [404, odooError('odoo.exceptions.MissingError', 'Record does not exist or has been deleted.')]
      if (typeof body.body !== 'string' || !body.body.trim()) return [500, odooError('odoo.exceptions.ValidationError', 'body is required')]
      // Odoo would send this to the followers and recipients; only an internal note is silent, and the rehearsal accepts nothing else.
      if (body.subtype_xmlid !== 'mail.mt_note') return [500, odooError('builtins.ValueError', 'the rehearsal accepts only the internal note subtype, mail.mt_note')]
      if (body.message_type !== 'comment') return [500, odooError('builtins.ValueError', "the rehearsal accepts only message_type 'comment'")]
      const attached = Array.isArray(body.attachment_ids) ? body.attachment_ids : []
      if (attached.some((id) => !attachments.some((attachment) => attachment.id === id && attachment.resId === body.ids[0]))) return [404, odooError('odoo.exceptions.MissingError', 'an attachment does not exist or belongs to another record')]
      const note = { id: nextNoteId++, partnerId: body.ids[0], body: body.body, attachmentIds: attached }
      notes.push(note)
      log(`NOTE res.partner ${note.partnerId} (${partners.get(note.partnerId)}) internal note ${note.id} "${note.body}" attachments ${JSON.stringify(attached)} -> no mail, no recipients`)
      return [200, note.id]
    }
    if (!data[model]) return [404, odooError('odoo.exceptions.MissingError', 'unknown model')]
    if (method === 'fields_get') return [200, demoFields[model]]
    if (method === 'search_count') return [200, data[model].length]
    if (method === 'search_read') {
      const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : Object.keys(demoFields[model])
      // A domain that starts with an id is a read of one record, as the gateway does before it posts a document.
      const id = idFilter(body.domain)
      const all = id === null ? data[model] : data[model].filter((row) => row.id === id)
      const rows = all.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 80))
      return [200, rows.map((row) => pick(row, wanted))]
    }
    return [404, odooError('odoo.exceptions.MissingError', 'unknown method')]
  }

  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const [, , , model, method] = new URL(req.url, 'http://x').pathname.split('/')
    if (!/^bearer .+/i.test(req.headers.authorization ?? '')) return send(401, odooError('odoo.exceptions.AccessDenied', 'no key'))
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return send(422, odooError('builtins.ValueError', 'invalid JSON'))
    }
    return send(...handle(model, method, body))
  })

  return { server, employees, leaves, attachments, notes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DEMO_ODOO_PORT ?? 18069)
  const { server } = createDemoOdoo({ log: (line) => console.error(line) })
  server.listen(port, '127.0.0.1', () => console.error('demo odoo on', port))
}
