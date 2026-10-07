/* What the availability API of the dashboard (src/lib/availability-handlers.ts) sends to the screens. */

/**
 * What is known of the record in Odoo that marks the period. `none`: the period is only in the dashboard (the technician is not
 * an Odoo employee, or sending to Odoo is switched off). `failed`: Odoo refused, nothing was marked, it can be sent again.
 * `unknown`: no usable answer, the record may exist in Odoo.
 */
export type AvailabilityOdoo =
  | { state: 'none' }
  | { state: 'synced'; /** Reading the record back confirmed the right employee and days. */ verified: boolean }
  | { state: 'failed' | 'unknown'; message: string }

/** A period in which a technician is not available; `from` and `to` are calendar days (2026-10-07), both included. */
export type AvailabilityPeriod = {
  id: string
  accountId: string
  /** The name of the technician. */
  name: string
  from: string
  to: string
  note: string
  odoo: AvailabilityOdoo
}

export type AvailabilityResponse = {
  /** Today in the Netherlands (2026-10-07). */
  today: string
  /** True for a technician (his own periods); the planner only looks. */
  canEdit: boolean
  periods: AvailabilityPeriod[]
}
