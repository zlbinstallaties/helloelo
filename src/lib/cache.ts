import { withCache } from '@helloleo/runtime'
import { callIntegration } from '#/lib/proxy.server'
import type { DashboardData } from '#/lib/dashboard-types'

const TEST_COMPANY_ID = 2

async function readOdoo<T>(model: string, fields: string[]) {
  const response = await callIntegration<{ result: T[] }>({
    integration: 'odoo',
    endpoint: '/jsonrpc',
    body: {
      model,
      method: 'search_read',
      args: [[['company_id', '=', TEST_COMPANY_ID]]],
      kwargs: { fields, limit: 500, offset: 0 },
    },
  })

  if (!response.success) {
    throw new Error(`Odoo ${model} read failed (${response.status})`)
  }

  return response.data?.result ?? []
}

export const getDigDashboardData = withCache(
  'odoo:dig-dashboard',
  300,
  async (): Promise<DashboardData> => {
    const slots = await readOdoo<DashboardData['slots'][number]>('planning.slot', [
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
      ])
    const visits = await readOdoo<DashboardData['visits'][number]>('svs.tech.visit', [
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
      ])

    return {
      company: {
        id: TEST_COMPANY_ID,
        name: 'De Installatiegroep B.V. [TEST]',
      },
      slots,
      visits,
      loadedAt: new Date().toISOString(),
    }
  },
)
