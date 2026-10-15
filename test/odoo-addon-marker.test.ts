import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { UNAVAILABILITY_MARKER } from '../gateway/src/actions.ts'

// The Odoo module that asks the planner for a confirmation recognises the records of the dashboard by their name. If the gateway
// names them differently, the question would silently never be asked.
test('the Odoo module and the gateway use the same marker for the records of the dashboard', () => {
  const source = readFileSync(new URL('../odoo_addon/dig_planning_unavailability/models/planning_slot.py', import.meta.url), 'utf8')
  const match = /^MARKER = "(.+)"$/m.exec(source)
  assert.ok(match, 'MARKER is defined in planning_slot.py')
  assert.equal(match[1], UNAVAILABILITY_MARKER)
})

test('the module only depends on what it uses, and does not ship its own tables or access rules', () => {
  const manifest = readFileSync(new URL('../odoo_addon/dig_planning_unavailability/__manifest__.py', import.meta.url), 'utf8')
  assert.match(manifest, /"depends": \["planning", "resource"\]/)
  assert.doesNotMatch(manifest, /ir\.access|security\//)
})
