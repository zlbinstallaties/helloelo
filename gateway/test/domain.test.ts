import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDomain, validateFields, validateOrder } from '../src/domain.ts'
import { GatewayError } from '../src/errors.ts'

const allowed = ['id', 'name', 'state', 'start_datetime']

function code(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof GatewayError)
    return error.code
  }
  assert.fail('expected an error')
}

test('valid domains return the used fields', () => {
  assert.deepEqual(validateDomain(undefined, allowed), [])
  assert.deepEqual(validateDomain([['state', '=', 'done']], allowed), ['state'])
  assert.deepEqual(
    validateDomain(['|', ['state', 'in', ['a', 'b']], '!', ['name', 'ilike', 'x']], allowed).sort(),
    ['name', 'state'],
  )
  assert.deepEqual(validateDomain([['state', '=', false], ['id', '>', 3]], allowed).sort(), ['id', 'state'])
})

test('fields outside the allowlist and dotted paths are refused', () => {
  assert.equal(code(() => validateDomain([['company_id', '=', 1]], allowed)), 'field_not_allowed')
  assert.equal(code(() => validateDomain([['partner_id.name', '=', 'x']], allowed)), 'field_not_allowed')
})

test('dangerous operators and values are refused', () => {
  for (const op of ['child_of', 'parent_of', 'any', 'not any', '=?']) {
    assert.equal(code(() => validateDomain([['state', op, 1]], allowed)), 'invalid_domain')
  }
  assert.equal(code(() => validateDomain([['state', '=', { a: 1 }]], allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain([['state', 'in', 'a']], allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain([['state', '=', 'x'.repeat(501)]], allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain([['state', '=']], allowed)), 'invalid_domain')
})

test('incomplete expressions are refused so the company filter stays ANDed', () => {
  assert.equal(code(() => validateDomain(['|', ['state', '=', 'a']], allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain(['!'], allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain(['|'], allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain('state = 1', allowed)), 'invalid_domain')
  assert.equal(code(() => validateDomain(Array(51).fill(['id', '=', 1]), allowed)), 'invalid_domain')
})

test('order is validated and normalized', () => {
  assert.equal(validateOrder(undefined, allowed), undefined)
  assert.equal(validateOrder('start_datetime DESC, id', allowed), 'start_datetime desc, id')
  assert.equal(code(() => validateOrder('company_id', allowed)), 'field_not_allowed')
  assert.equal(code(() => validateOrder('id; drop table', allowed)), 'invalid_order')
})

test('fields default to the allowlist and cannot be widened', () => {
  assert.deepEqual(validateFields(undefined, allowed), allowed)
  assert.deepEqual(validateFields(['name', 'name'], allowed), ['name'])
  assert.equal(code(() => validateFields(['password'], allowed)), 'field_not_allowed')
  assert.equal(code(() => validateFields([], allowed)), 'invalid_fields')
})
