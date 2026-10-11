import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CUSTOMER_FACTS } from '../src/lib/documents/customer-facts.ts'

// The Odoo module `dig_schouw_facts` creates the fields that the dashboard fills in on the customer. If the names, the types or the
// choices differ from the table of the dashboard, a write would fail in Odoo (or a value would be refused): so they are compared here.

const source = readFileSync(new URL('../odoo_addon/dig_schouw_facts/models/res_partner.py', import.meta.url), 'utf8')
const view = readFileSync(new URL('../odoo_addon/dig_schouw_facts/views/res_partner_views.xml', import.meta.url), 'utf8')
const manifest = readFileSync(new URL('../odoo_addon/dig_schouw_facts/__manifest__.py', import.meta.url), 'utf8')

const PYTHON_TYPE: Record<string, string> = { selection: 'Selection', integer: 'Integer', float: 'Float', char: 'Char', text: 'Text', date: 'Date' }

/** The statements `    dig_schouw_x = fields.Type(...)` of the module, up to the next one. */
function parseFields() {
  const found = new Map<string, { type: string; body: string }>()
  const pattern = /^    (dig_[a-z0-9_]+) = fields\.(\w+)\(/gm
  const starts: Array<{ name: string; type: string; at: number }> = []
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) starts.push({ name: match[1], type: match[2], at: match.index })
  starts.forEach((start, index) => found.set(start.name, { type: start.type, body: source.slice(start.at, starts[index + 1]?.at ?? source.length) }))
  return found
}

/** The values of a selection: `("hybride", "Hybride warmtepomp")` pairs, or the shared YES_NO list. */
function choicesOf(body: string): string[] {
  const text = body.includes('YES_NO,') || /\(\s*YES_NO\s*,/.test(body) ? 'YES_NO' : body
  if (text === 'YES_NO') return ['ja', 'nee']
  return [...body.matchAll(/\("([^"]+)",\s*"[^"]*"\)/g)].map((match) => match[1])
}

test('the module defines exactly the fields of the table, with the same types', () => {
  const fields = parseFields()
  assert.deepEqual([...fields.keys()].sort(), CUSTOMER_FACTS.map((spec) => spec.field).sort())
  for (const spec of CUSTOMER_FACTS) {
    assert.equal(fields.get(spec.field)?.type, PYTHON_TYPE[spec.type], spec.field)
  }
})

test('the choices of a selection are the choices of the table, in the same order', () => {
  const fields = parseFields()
  for (const spec of CUSTOMER_FACTS) {
    if (spec.type !== 'selection') continue
    assert.deepEqual(choicesOf(fields.get(spec.field)!.body), [...spec.options], spec.field)
  }
})

test('a duplicated contact does not take a schouw along, and the module adds fields to the contact and nothing else', () => {
  for (const [name, field] of parseFields()) assert.match(field.body, /copy=False/, name)
  assert.match(source, /_inherit = "res\.partner"/)
  assert.doesNotMatch(source, /_name\s*=/, 'no model of its own')
  assert.equal((source.match(/^class /gm) ?? []).length, 1)
})

test('the screen shows every field once, on the contact form', () => {
  assert.match(view, /inherit_id" ref="base\.view_partner_form"/)
  for (const spec of CUSTOMER_FACTS) {
    assert.equal((view.match(new RegExp(`<field name="${spec.field}"`, 'g')) ?? []).length, 1, spec.field)
  }
  assert.match(view, /<field name="dig_schouw_bouwjaar" options="\{'format': false\}"\/>/, 'a year is not written as 1.985')
})

test('the module depends only on base and ships no tables or access rules of its own', () => {
  assert.match(manifest, /"depends": \["base"\]/)
  assert.doesNotMatch(manifest, /ir\.access|security\//)
  assert.match(manifest, /"views\/res_partner_views\.xml"/)
})
