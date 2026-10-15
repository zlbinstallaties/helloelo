export type OdooMany2One = [number, string] | false

export type DashboardSlot = {
  id: number
  name: string
  start_datetime: string
  end_datetime: string
  allocated_hours: number
  role_id: OdooMany2One
  user_ids: Array<[number, string]>
  employee_ids: Array<[number, string]>
  partner_id: OdooMany2One
  partner_name: string
  partner_address: string
  sale_order_id: OdooMany2One
  sale_line_id: OdooMany2One
  state: string
  svs_tech_visit_ids: number[]
  travel_time_in: number
  travel_time_out: number
  travel_times_up_to_date: boolean
}

export type DashboardVisit = {
  id: number
  name: string
  state: string
  visit_date: string
  partner_id: OdooMany2One
  technician_id: OdooMany2One
  template_id: OdooMany2One
  slot_id: OdooMany2One
  task_id: OdooMany2One
  is_complete: boolean
  is_sent: boolean
  missing_required_count: number
  missing_required_inputs_count: number
  photo_count: number
  photo_ids: number[]
  notes: string
}

export type DashboardData = {
  company: { id: number; name: string }
  slots: DashboardSlot[]
  visits: DashboardVisit[]
  /** True when the maximum number of records was read and Odoo has more (see src/lib/paging.ts). */
  truncated: boolean
  loadedAt: string
}

export type DashboardAppointmentVisit = {
  id: number
  name: string
  state: string
  visitDate: string
  technician: string | null
  template: string | null
  isComplete: boolean
  isSent: boolean
  missingRequired: number
  missingInputs: number
  photoCount: number
  /** Left out (null) for people without an Odoo account. */
  odooUrl: string | null
}

/**
 * Someone assigned to an appointment. `id` is stable and unique: `employee:<hr.employee id>`,
 * `user:<res.users id>` or, only when Odoo sent no id at all, `name:<name>`. `name` is for display.
 */
export type DashboardPerson = {
  id: string
  name: string
  /**
   * Other ids this person is known under, e.g. `user:5` for `employee:7`. A link made with one of those keeps
   * working when the planning later lists the person under another id. Left out when there are none.
   */
  alsoIds?: string[]
}

export type DashboardAppointment = {
  id: string
  slotId: number | null
  /** First visit of the appointment (lowest id); see `visits` for all of them. */
  visitId: number | null
  visitName: string | null
  /** All DIG visits of this appointment, sorted by id. Empty when there are none. */
  visits: DashboardAppointmentVisit[]
  title: string
  start: string | null
  end: string | null
  visitDate: string
  customer: string
  address: string
  role: string
  people: DashboardPerson[]
  state: string
  /** Totals over all visits of the appointment; null when it has no visits. */
  missingRequired: number | null
  missingInputs: number | null
  photoCount: number | null
  travelTimeIn: number | null
  travelTimeOut: number | null
  travelTimesUpToDate: boolean
  assigned: boolean
  scheduled: boolean
  odooUrl: string | null
}

export type DashboardResponse = {
  company: DashboardData['company']
  appointments: DashboardAppointment[]
  technicians: Array<{ value: string; label: string }>
  scope: 'day' | 'upcoming' | 'all'
  date: string
  /** The data is incomplete: the maximum number of records was read and Odoo has more. */
  truncated: boolean
  loadedAt: string
}
