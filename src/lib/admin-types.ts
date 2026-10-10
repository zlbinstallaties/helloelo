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

/** A planning role (`planning.role`) of Odoo that a technician can be given. */
export type PlanningRole = { id: number; name: string }

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

/** The planning roles an existing technician has in Odoo now (the default role first when it is among them). */
export type TechnicianRoles = {
  employeeId: number
  planningRoleIds: number[]
  defaultPlanningRoleId: number | null
}

/** What Odoo confirmed after the roles of a technician were changed. */
export type TechnicianRolesSaved = {
  employeeId: number
  /** How many roles Odoo confirmed on the employee afterwards. */
  planningRoles: number
  /** How many roles were asked. */
  asked: number
}
