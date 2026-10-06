import type { DashboardData } from '#/lib/dashboard-types'
import { searchReadAll } from '#/lib/gateway.server'
import { withCache } from '#/lib/ttl-cache'

// Display only: the gateway project config enforces the company on every read.
const TEST_COMPANY_ID = 2

export const getDigDashboardData = withCache(
  'odoo:dig-dashboard',
  300,
  async (): Promise<DashboardData> => {
    // Newest first, so that when the maximum is reached (src/lib/paging.ts) the oldest appointments are the ones
    // left out. `id` as the last key gives every record a fixed place, which paging needs.
    const slotsRead = await searchReadAll<DashboardData['slots'][number]>('planning.slot', [
        'id',
        'name',
        'start_datetime',
        'end_datetime',
        'allocated_hours',
        'role_id',
        'user_ids',
        'employee_ids',
        'partner_id',
        'partner_name',
        'partner_address',
        'sale_order_id',
        'sale_line_id',
        'state',
        'svs_tech_visit_ids',
        'travel_time_in',
        'travel_time_out',
        'travel_times_up_to_date',
      ], 'start_datetime desc, id desc')
    const visitsRead = await searchReadAll<DashboardData['visits'][number]>('svs.tech.visit', [
        'id',
        'name',
        'state',
        'visit_date',
        'partner_id',
        'technician_id',
        'template_id',
        'slot_id',
        'task_id',
        'is_complete',
        'is_sent',
        'missing_required_count',
        'missing_required_inputs_count',
        'photo_count',
        'photo_ids',
        'notes',
      ], 'visit_date desc, id desc')

    return {
      company: {
        id: TEST_COMPANY_ID,
        name: 'De Installatiegroep B.V. [TEST]',
      },
      slots: slotsRead.records,
      visits: visitsRead.records,
      truncated: slotsRead.truncated || visitsRead.truncated,
      loadedAt: new Date().toISOString(),
    }
  },
)
