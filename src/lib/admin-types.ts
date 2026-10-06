import type { PublicAccount } from './accounts.ts'

/* What the admin API of the dashboard (src/lib/admin-handlers.ts) sends to the screens. */

export type AccountRow = PublicAccount & {
  /** The name of the linked person in the planning; null when they are not (yet) in it. */
  personName: string | null
  /** True when the person is in the planning, false when not yet planned, null when the planning could not be read. */
  personInPlanning: boolean | null
}

export type PersonChoice = { value: string; label: string; hasAccount: boolean }

export type AccountsResponse = {
  accounts: AccountRow[]
  persons: PersonChoice[]
  currentUserId: string
  planningError: string | null
}

export type TechnicianCreated = {
  employeeId: number
  verified: boolean
  /** How many planning roles Odoo confirmed on the new employee (0: none set up, so Planning cannot take him for a shift with a role). */
  planningRoles: number
  replayed: boolean
  account: PublicAccount | null
  /** Shown once; null for a repeat. */
  password: string | null
}
