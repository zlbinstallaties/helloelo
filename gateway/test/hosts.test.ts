import test from 'node:test'
import assert from 'node:assert/strict'
import { checkOdooHost, parseAllowedHosts } from '../src/hosts.ts'
import { GatewayError } from '../src/errors.ts'

const TEST_HOST = 'odoo20.srv1938209.hstgr.cloud'

function code(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof GatewayError)
    return error.code
  }
  assert.fail('expected an error')
}

test('the listed test host is accepted', () => {
  assert.equal(checkOdooHost(`https://${TEST_HOST}`, [TEST_HOST]), TEST_HOST)
  assert.equal(checkOdooHost(`https://${TEST_HOST.toUpperCase()}/web`, [TEST_HOST]), TEST_HOST)
})

test('hosts that are not listed are refused, and an empty list refuses everything', () => {
  assert.equal(code(() => checkOdooHost('https://other.example.com', [TEST_HOST])), 'odoo_host_not_allowed')
  assert.equal(code(() => checkOdooHost(`https://${TEST_HOST}`, [])), 'odoo_host_not_allowed')
  assert.equal(code(() => checkOdooHost(`https://${TEST_HOST}.evil.com`, [TEST_HOST])), 'odoo_host_not_allowed')
})

test('Odoo.sh and odoo.com are refused even when listed', () => {
  for (const host of ['dig.odoo.sh', 'dig-main-1234.dev.odoo.com', 'dig.odoo.com', 'odoo.com']) {
    assert.equal(code(() => checkOdooHost(`https://${host}`, [host])), 'odoo_host_forbidden', host)
  }
})

test('invalid urls are refused and the host list is parsed', () => {
  assert.equal(code(() => checkOdooHost('not a url', [TEST_HOST])), 'invalid_odoo_url')
  assert.deepEqual(parseAllowedHosts(' A.example.com , ,b.example.com '), ['a.example.com', 'b.example.com'])
  assert.deepEqual(parseAllowedHosts(undefined), [])
})
