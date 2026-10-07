/* What the availability API of the dashboard (src/lib/availability-handlers.ts) sends to the screens. */

/** A period in which a technician is not available; `from` and `to` are calendar days (2026-10-07), both included. */
export type AvailabilityPeriod = {
  id: string
  accountId: string
  /** The name of the technician. */
  name: string
  from: string
  to: string
  note: string
}

export type AvailabilityResponse = {
  /** Today in the Netherlands (2026-10-07). */
  today: string
  /** True for a technician (his own periods); the planner only looks. */
  canEdit: boolean
  periods: AvailabilityPeriod[]
}
