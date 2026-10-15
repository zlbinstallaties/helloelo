import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountStore } from '../src/lib/accounts.ts'
import { suggestUsername } from '../src/lib/username.ts'

test('a name becomes a user name: lower case, dots between words, no accents', () => {
  assert.equal(suggestUsername('Els Bakker'), 'els.bakker')
  assert.equal(suggestUsername('  Jan   de Vries '), 'jan.de.vries')
  assert.equal(suggestUsername('Jörg Ünal'), 'jorg.unal')
  assert.equal(suggestUsername('Zoë van den Berg'), 'zoe.van.den.berg')
})

test('characters that are not allowed are dropped, and too short or empty gives nothing', () => {
  assert.equal(suggestUsername("Piet O'Brien-Smit"), 'piet.obrien-smit')
  assert.equal(suggestUsername('!!!'), '')
  assert.equal(suggestUsername(''), '')
  assert.equal(suggestUsername('Al'), '')
  assert.equal(suggestUsername('Li X'), 'li.x')
})

test('it is never longer than a user name may be, and does not end in a dot', () => {
  const long = suggestUsername('Alexandra Wilhelmina Maria van der Waals-Hendriksen de Tweede')
  assert.ok(long.length <= 40, long)
  assert.ok(!long.endsWith('.') && !long.endsWith('-'))
})

test('whatever it suggests is a user name the server accepts', () => {
  const store = createAccountStore({ io: { read: () => null, write: () => {} } })
  for (const name of ['Els Bakker', 'Jörg Ünal', "Piet O'Brien-Smit", 'Jan de Vries', 'Alexandra Wilhelmina Maria van der Waals-Hendriksen']) {
    const username = suggestUsername(name)
    assert.ok(username, name)
    assert.doesNotThrow(() => store.precheck({ username, name }), name)
  }
})
