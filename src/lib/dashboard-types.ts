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
  loadedAt: string
}

export type DashboardAppointment = {
  id: string
  slotId: number | null
  visitId: number | null
  visitName: string | null
  title: string
  start: string | null
  end: string | null
  visitDate: string
  customer: string
  address: string
  role: string
  people: string[]
  state: string
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
  loadedAt: string
}
