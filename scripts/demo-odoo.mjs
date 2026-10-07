// Demo Odoo for trial runs: a tiny stand-in for the Odoo JSON-2 API with sample
// data for planning.slot and svs.tech.visit, and just enough of res.users and
// hr.employee to rehearse "add a technician" (see docs/lokaal-testen.md).
// NOT a real Odoo; no auth beyond a non-empty bearer token.
// Usage: node scripts/demo-odoo.mjs   (port 18069, DEMO_ODOO_PORT to change)
//
// `hr.employee/write` understands only the two planning-role fields (all the dashboard ever changes); anything else is an error.
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

const odooError = (name, message) => ({ name, message, arguments: [message], context: {}, debug: '' })
const idFilter = (domain) => (Array.isArray(domain) && domain.length >= 1 && Array.isArray(domain[0]) && domain[0][0] === 'id' && domain[0][1] === '=' ? domain[0][2] : null)
const pick = (row, wanted) => Object.fromEntries(wanted.filter((field) => field in row).map((field) => [field, row[field]]))

/** `log` gets one line per write. `employees` is the in-memory hr.employee table, for tests. */
export function createDemoOdoo({ log = () => {} } = {}) {
  const data = demoData()
  const employees = []
  let nextEmployeeId = 900

  function employeeRow(employee) {
    return {
      id: employee.id,
      name: employee.name,
      company_id: [employee.companyId, COMPANY_NAME],
      user_id: employee.userId ? [employee.userId, 'Gebruiker'] : false,
      planning_role_ids: [...employee.roleIds],
      default_planning_role_id: employee.defaultRoleId ? [employee.defaultRoleId, ROLES.find((role) => role.id === employee.defaultRoleId)?.name ?? ''] : false,
      active: true,
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
    if (!data[model]) return [404, odooError('odoo.exceptions.MissingError', 'unknown model')]
    if (method === 'fields_get') return [200, demoFields[model]]
    if (method === 'search_count') return [200, data[model].length]
    if (method === 'search_read') {
      const wanted = Array.isArray(body.fields) && body.fields.length ? body.fields : Object.keys(demoFields[model])
      const rows = data[model].slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 80))
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

  return { server, employees }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DEMO_ODOO_PORT ?? 18069)
  const { server } = createDemoOdoo({ log: (line) => console.error(line) })
  server.listen(port, '127.0.0.1', () => console.error('demo odoo on', port))
}
