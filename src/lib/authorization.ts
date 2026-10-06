import { personHasId, technicianOptions } from './appointments.ts'
import type { Role } from './accounts.ts'
import type { DashboardAppointment } from './dashboard-types.ts'

/*
 * What a logged-in person may see and do. No I/O, so it is unit-tested in test/.
 *
 * - An admin sees every appointment, with the links to Odoo, may refresh the data from Odoo and manages accounts.
 * - A technician sees only the appointments of the person their account is linked to (`personId`), without links
 *   to Odoo (they have no Odoo account), and cannot refresh or manage accounts. A technician without a person, or
 *   with a person nobody is planned as, sees nothing, never everything.
 */

export type User = {
  id: string
  username: string
  name: string
  role: Role
  personId: string | null
  /** The admin from the server settings, not from the account file. */
  emergency: boolean
}

export const canRefresh = (user: User) => user.role === 'admin'
export const canManageAccounts = (user: User) => user.role === 'admin'

function withoutOdooLinks(appointment: DashboardAppointment): DashboardAppointment {
  return {
    ...appointment,
    odooUrl: null,
    visits: appointment.visits.map((visit) => ({ ...visit, odooUrl: null })),
  }
}

/** The appointments this user may see. Never changes `appointments`. */
export function visibleAppointments(user: User, appointments: DashboardAppointment[]): DashboardAppointment[] {
  if (user.role === 'admin') return appointments
  const personId = user.personId
  if (!personId) return []
  return appointments
    .filter((appointment) => appointment.people.some((person) => personHasId(person, personId)))
    .map(withoutOdooLinks)
}

/** The choices of the technician filter: for admins only, a technician only ever sees their own. */
export function technicianChoicesFor(user: User, appointments: DashboardAppointment[]) {
  return user.role === 'admin' ? technicianOptions(appointments) : []
}
