import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountError, AccountsFileError, createAccountStore } from '../src/lib/accounts.ts'
import type { AccountIo } from '../src/lib/accounts.ts'
import { hashPassword } from '../src/lib/password.ts'

const PASSWORD = 'een-goed-wachtwoord'

function memoryIo(initial: string | null = null) {
  const state = { text: initial, writes: 0 }
  const io: AccountIo = {
    read: () => state.text,
    write: (text) => {
      state.text = text
      state.writes += 1
    },
  }
  return { io, state }
}

function store(initial: string | null = null, options: { reservedUsernames?: string[] } = {}) {
  const { io, state } = memoryIo(initial)
  let counter = 0
  const accounts = createAccountStore({
    io,
    now: () => new Date('2026-10-06T10:00:00Z'),
    newId: () => `u_${++counter}`,
    ...options,
  })
  return { accounts, state, io }
}

function addMonteur(accounts: ReturnType<typeof store>['accounts'], username = 'jan', personId = 'employee:7') {
  return accounts.create({ username, name: 'Jan de Vries', role: 'monteur', personId, password: PASSWORD })
}

function assertError(action: () => unknown, code: AccountError['code'], message: RegExp) {
  assert.throws(action, (error) => error instanceof AccountError && error.code === code && message.test(error.message))
}

test('a new store is empty, also when the file does not exist yet', () => {
  assert.deepEqual(store().accounts.list(), [])
})

test('a created account is listed without its password or hash, and the hash on disk is not the password', () => {
  const { accounts, state } = store()
  const created = addMonteur(accounts)
  assert.deepEqual(created, {
    id: 'u_1',
    username: 'jan',
    name: 'Jan de Vries',
    role: 'monteur',
    personId: 'employee:7',
    disabled: false,
    createdAt: '2026-10-06T10:00:00.000Z',
  })
  assert.deepEqual(accounts.list(), [created])
  assert.ok(!JSON.stringify(accounts.list()).includes('scrypt'))
  assert.ok(state.text?.includes('scrypt:'))
  assert.ok(!state.text?.includes(PASSWORD))
})

test('accounts are saved in one write per change and read back by a new store', () => {
  const { accounts, state, io } = store()
  addMonteur(accounts)
  assert.equal(state.writes, 1)
  assert.equal(JSON.parse(state.text as string).version, 1)
  const again = createAccountStore({ io })
  assert.equal(again.list().length, 1)
  assert.ok(again.authenticate('jan', PASSWORD))
})

test('user names are lower-cased and trimmed, and are unique whatever the case', () => {
  const { accounts } = store()
  assert.equal(accounts.create({ username: '  Jan.DeVries ', name: 'Jan', role: 'monteur', personId: 'employee:7', password: PASSWORD }).username, 'jan.devries')
  assertError(
    () => accounts.create({ username: 'JAN.devries', name: 'Jan 2', role: 'monteur', personId: 'employee:8', password: PASSWORD }),
    'conflict',
    /bestaat al/,
  )
})

test('invalid user names are refused with a reason', () => {
  const { accounts } = store()
  for (const username of ['', 'ab', 'a b c', '.jan', 'jan!', 'x'.repeat(41), 'jan@bedrijf', 'ja\nn']) {
    assertError(
      () => accounts.create({ username, name: 'Jan', role: 'monteur', personId: 'employee:7', password: PASSWORD }),
      'invalid',
      /gebruikersnaam/i,
    )
  }
})

test('the name of the emergency admin cannot be taken by an account', () => {
  const { accounts } = store(null, { reservedUsernames: ['admin'] })
  assertError(
    () => accounts.create({ username: 'ADMIN', name: 'Nep', role: 'admin', personId: null, password: PASSWORD }),
    'conflict',
    /bestaat al/,
  )
})

test('a technician needs a person from the planning, and every person gets one account only', () => {
  const { accounts } = store()
  assertError(
    () => accounts.create({ username: 'jan', name: 'Jan', role: 'monteur', personId: null, password: PASSWORD }),
    'invalid',
    /persoon/,
  )
  assertError(
    () => accounts.create({ username: 'jan', name: 'Jan', role: 'monteur', personId: '  ', password: PASSWORD }),
    'invalid',
    /persoon/,
  )
  addMonteur(accounts, 'jan', 'employee:7')
  assertError(() => addMonteur(accounts, 'jan2', 'employee:7'), 'conflict', /al een account/)
  assert.ok(addMonteur(accounts, 'sanne', 'employee:8'))
})

test('an admin does not need a person', () => {
  const { accounts } = store()
  const admin = accounts.create({ username: 'beheer', name: 'Beheer', role: 'admin', personId: null, password: PASSWORD })
  assert.equal(admin.personId, null)
  assert.equal(admin.role, 'admin')
})

test('name and role are checked', () => {
  const { accounts } = store()
  assertError(() => accounts.create({ username: 'jan', name: '   ', role: 'monteur', personId: 'employee:7', password: PASSWORD }), 'invalid', /naam/)
  assertError(() => accounts.create({ username: 'jan', name: 'x'.repeat(81), role: 'monteur', personId: 'employee:7', password: PASSWORD }), 'invalid', /naam/)
  assertError(
    () => accounts.create({ username: 'jan', name: 'Jan', role: 'baas' as 'admin', personId: 'employee:7', password: PASSWORD }),
    'invalid',
    /rol/,
  )
})

test('the password policy applies when creating, resetting and changing', () => {
  const { accounts } = store()
  assertError(() => accounts.create({ username: 'jan', name: 'Jan', role: 'monteur', personId: 'employee:7', password: 'kort' }), 'invalid', /minstens 12/)
  const jan = addMonteur(accounts)
  assertError(() => accounts.resetPassword(jan.id, 'kort'), 'invalid', /minstens 12/)
  assertError(() => accounts.changeOwnPassword(jan.id, PASSWORD, 'kort'), 'invalid', /minstens 12/)
  assert.ok(accounts.authenticate('jan', PASSWORD), 'the old password still works after the refusals')
})

test('authenticate: the right password gives the account, anything else gives null', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  assert.equal(accounts.authenticate('jan', PASSWORD)?.id, jan.id)
  assert.equal(accounts.authenticate(' JAN ', PASSWORD)?.id, jan.id, 'case and spaces in the user name do not matter')
  assert.equal(accounts.authenticate('jan', PASSWORD + 'x'), null)
  assert.equal(accounts.authenticate('jan', PASSWORD.toUpperCase()), null, 'the password is case sensitive')
  assert.equal(accounts.authenticate('niemand', PASSWORD), null)
  assert.equal(accounts.authenticate('', ''), null)
})

test('a disabled account cannot log in, an enabled one can again', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  accounts.update(jan.id, { disabled: true })
  assert.equal(accounts.authenticate('jan', PASSWORD), null)
  accounts.update(jan.id, { disabled: false })
  assert.ok(accounts.authenticate('jan', PASSWORD))
})

test('session versions: disabling, a new role or person and a new password end the sessions of that account', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  const version = () => accounts.sessionVersion(jan.id)
  assert.equal(version(), 0)
  accounts.update(jan.id, { name: 'Jan V.' })
  assert.equal(version(), 0, 'a new display name keeps the sessions')
  accounts.update(jan.id, { disabled: true })
  assert.equal(version(), 1)
  accounts.update(jan.id, { disabled: false })
  assert.equal(version(), 2)
  accounts.update(jan.id, { personId: 'employee:9' })
  assert.equal(version(), 3)
  accounts.update(jan.id, { role: 'admin' })
  assert.equal(version(), 4)
  accounts.resetPassword(jan.id, 'een-ander-wachtwoord')
  assert.equal(version(), 5)
  assert.equal(accounts.sessionVersion('bestaat-niet'), null)
})

test('update changes only what is given and keeps the rules (one account per person, a technician keeps a person)', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts, 'jan', 'employee:7')
  const sanne = addMonteur(accounts, 'sanne', 'employee:8')
  assert.equal(accounts.update(jan.id, { name: 'Jan V.' }).name, 'Jan V.')
  assert.equal(accounts.list().find((a) => a.id === jan.id)?.personId, 'employee:7')
  assertError(() => accounts.update(sanne.id, { personId: 'employee:7' }), 'conflict', /al een account/)
  assertError(() => accounts.update(sanne.id, { personId: null }), 'invalid', /persoon/)
  assertError(() => accounts.update(sanne.id, { name: '' }), 'invalid', /naam/)
  assertError(() => accounts.update('u_nope', { name: 'X' }), 'not_found', /niet gevonden/)
})

test('a new password replaces the old one', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  accounts.resetPassword(jan.id, 'een-ander-wachtwoord')
  assert.equal(accounts.authenticate('jan', PASSWORD), null)
  assert.ok(accounts.authenticate('jan', 'een-ander-wachtwoord'))
  assertError(() => accounts.resetPassword('u_nope', 'een-ander-wachtwoord'), 'not_found', /niet gevonden/)
})

test('changing your own password needs the current one', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  assertError(() => accounts.changeOwnPassword(jan.id, 'verkeerd-wachtwoord', 'een-ander-wachtwoord'), 'invalid', /huidige wachtwoord/)
  accounts.changeOwnPassword(jan.id, PASSWORD, 'een-ander-wachtwoord')
  assert.ok(accounts.authenticate('jan', 'een-ander-wachtwoord'))
  assert.equal(accounts.authenticate('jan', PASSWORD), null)
})

test('removing an account frees its user name and its person', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  accounts.remove(jan.id)
  assert.deepEqual(accounts.list(), [])
  assert.equal(accounts.authenticate('jan', PASSWORD), null)
  assert.ok(addMonteur(accounts, 'jan', 'employee:7'))
  assertError(() => accounts.remove('u_nope'), 'not_found', /niet gevonden/)
})

test('accounts are listed by name, as people read them', () => {
  const { accounts } = store()
  addMonteur(accounts, 'jan', 'employee:1')
  accounts.create({ username: 'sanne', name: 'sanne Bakker', role: 'monteur', personId: 'employee:2', password: PASSWORD })
  accounts.create({ username: 'els', name: 'Els Ä', role: 'monteur', personId: 'employee:3', password: PASSWORD })
  assert.deepEqual(accounts.list().map((a) => a.name), ['Els Ä', 'Jan de Vries', 'sanne Bakker'])
})

test('find by person: the account that belongs to a person', () => {
  const { accounts } = store()
  const jan = addMonteur(accounts)
  assert.equal(accounts.findByPerson('employee:7')?.id, jan.id)
  assert.equal(accounts.findByPerson('employee:9'), undefined)
})

test('a file that is not valid is an error and is never overwritten (no silent empty store)', () => {
  for (const text of ['{ kapot', '[]', '{"version":2,"accounts":[]}', '{"version":1}', '{"version":1,"accounts":[{"id":"u_1"}]}', '']) {
    const { accounts, state } = store(text)
    assert.throws(() => accounts.list(), AccountsFileError, text)
    assert.throws(() => addMonteur(accounts), AccountsFileError, text)
    assert.equal(state.text, text, 'the file is untouched')
    assert.equal(state.writes, 0)
  }
})

test('two accounts in a file with the same user name or person are refused', () => {
  const account = (id: string, username: string, personId: string) => ({
    id, username, name: 'N', role: 'monteur', personId, passwordHash: hashPassword(PASSWORD), sessionVersion: 0, disabled: false, createdAt: '2026-10-06T10:00:00.000Z',
  })
  for (const accounts of [
    [account('u_1', 'jan', 'employee:1'), account('u_2', 'jan', 'employee:2')],
    [account('u_1', 'jan', 'employee:1'), account('u_2', 'sanne', 'employee:1')],
    [account('u_1', 'jan', 'employee:1'), account('u_1', 'sanne', 'employee:2')],
  ]) {
    const { accounts: parsed } = store(JSON.stringify({ version: 1, accounts }))
    assert.throws(() => parsed.list(), AccountsFileError)
  }
})

test('the id of a new account is never one that is taken', () => {
  const { io } = memoryIo()
  const ids = ['u_1', 'u_1', 'u_2']
  const accounts = createAccountStore({ io, newId: () => ids.shift() ?? 'u_9' })
  accounts.create({ username: 'jan', name: 'Jan', role: 'monteur', personId: 'employee:1', password: PASSWORD })
  const second = accounts.create({ username: 'els', name: 'Els', role: 'monteur', personId: 'employee:2', password: PASSWORD })
  assert.equal(second.id, 'u_2')
})

test('precheck: the user name and name of a new account are checked before anything else is done, and nothing is saved', () => {
  const { accounts, state } = store(null, { reservedUsernames: ['noodadmin'] })
  addMonteur(accounts, 'jan', 'employee:7')
  const writes = state.writes
  assert.deepEqual(accounts.precheck({ username: '  Els.B ', name: ' Els Bakker ' }), { username: 'els.b', name: 'Els Bakker' })
  assertError(() => accounts.precheck({ username: 'JAN', name: 'Jan' }), 'conflict', /bestaat al/)
  assertError(() => accounts.precheck({ username: 'noodadmin', name: 'Nep' }), 'conflict', /bestaat al/)
  assertError(() => accounts.precheck({ username: 'a b', name: 'Jan' }), 'invalid', /gebruikersnaam/i)
  assertError(() => accounts.precheck({ username: 'els', name: '' }), 'invalid', /naam/)
  assertError(() => accounts.precheck({ username: 'els', name: 'x'.repeat(81) }), 'invalid', /naam/)
  assert.equal(state.writes, writes, 'nothing was written')
})

test('precheck on a damaged file is an error too, so nothing is started on top of it', () => {
  const { accounts } = store('{ kapot')
  assert.throws(() => accounts.precheck({ username: 'els', name: 'Els' }), AccountsFileError)
})

test('a name with a line break or another control character is refused, also when the account is made', () => {
  const { accounts } = store()
  for (const name of ['Jan\nde Vries', 'Jan\u0000', 'Jan\tde', 'Jan\u007f']) {
    assertError(() => accounts.precheck({ username: 'jan', name }), 'invalid', /naam/)
    assertError(() => accounts.create({ username: 'jan', name, role: 'monteur', personId: 'employee:7', password: PASSWORD }), 'invalid', /naam/)
  }
})
