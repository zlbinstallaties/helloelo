import assert from 'node:assert/strict'
import test from 'node:test'
import type { AccountIo } from '../src/lib/accounts.ts'
import { AvailabilityError, AvailabilityFileError, createAvailabilityStore } from '../src/lib/availability.ts'

function setup(nowIso = '2026-10-07T10:00:00Z') {
  const file = { text: null as string | null }
  const io: AccountIo = { read: () => file.text, write: (text) => (file.text = text) }
  const clock = { now: new Date(nowIso) }
  let counter = 0
  const store = createAvailabilityStore({ io, now: () => clock.now, newId: () => `p_${++counter}` })
  return { store, file, clock }
}

const jan = { accountId: 'u_jan' }
const add = (store: ReturnType<typeof setup>['store'], from: string, to: string, note?: unknown, owner = jan) =>
  store.add({ ...owner, from, to, note })
const code = (work: () => unknown) => {
  try {
    work()
  } catch (error) {
    assert.ok(error instanceof AvailabilityError, String(error))
    return error.code
  }
  return null
}

test('a period is kept with who it belongs to, and listed in the order of the dates', () => {
  const { store } = setup()
  const later = add(store, '2026-11-02', '2026-11-06', ' Vakantie ')
  const sooner = add(store, '2026-10-12', '2026-10-12')
  assert.deepEqual({ ...later, createdAt: '' }, { id: 'p_1', accountId: 'u_jan', from: '2026-11-02', to: '2026-11-06', note: 'Vakantie', createdAt: '' })
  assert.equal(later.createdAt, '2026-10-07T10:00:00.000Z')
  assert.equal(sooner.note, '', 'no note is an empty note')
  assert.deepEqual(store.list().map((period) => period.id), ['p_2', 'p_1'])
  assert.deepEqual(store.listFor('u_jan').length, 2)
  assert.deepEqual(store.listFor('u_anders'), [])
})

test('today is the day in the Netherlands, not in UTC', () => {
  const { store, clock } = setup('2026-10-06T22:30:00Z') // 00:30 on the 7th in Amsterdam
  assert.equal(store.today(), '2026-10-07')
  assert.equal(code(() => add(store, '2026-10-05', '2026-10-06')), 'invalid', 'wholly in the past')
  assert.equal(add(store, '2026-10-06', '2026-10-07').to, '2026-10-07', 'a period that runs into today is fine (someone ill since yesterday)')
  clock.now = new Date('2026-01-15T23:30:00Z') // winter time: 00:30 on the 16th
  assert.equal(store.today(), '2026-01-16')
})

test('dates must be real calendar dates in the form 2026-10-07', () => {
  const { store } = setup()
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '26-10-07', '2026-1-7', '', '2026-10-07T00:00', ' 2026-10-07', 20261007, null, undefined, {}, ['2026-10-07']]) {
    assert.equal(code(() => add(store, bad as string, '2026-12-01')), 'invalid', `from ${JSON.stringify(bad)}`)
    assert.equal(code(() => add(store, '2026-10-08', bad as string)), 'invalid', `to ${JSON.stringify(bad)}`)
  }
  assert.equal(add(store, '2028-02-29', '2028-02-29').from, '2028-02-29', 'a leap day is a day')
  assert.equal(code(() => add(store, '2027-02-29', '2027-02-29')), 'invalid')
  assert.equal(store.list().length, 1)
})

test('the end may not be before the start, and a period is at most 366 days, at most two years ahead', () => {
  const { store } = setup()
  assert.equal(code(() => add(store, '2026-10-20', '2026-10-19')), 'invalid')
  assert.equal(add(store, '2026-10-20', '2026-10-20').from, '2026-10-20', 'one day: from equals to')
  assert.equal(add(store, '2027-01-01', '2028-01-01').to, '2028-01-01', '366 days')
  assert.equal(code(() => add(store, '2027-02-01', '2028-02-02')), 'invalid', '367 days')
  assert.equal(code(() => add(store, '2027-02-01', '2028-02-03')), 'invalid', '368 days')
  assert.equal(code(() => add(store, '2028-10-08', '2028-10-09')), 'invalid', 'more than two years ahead')
  assert.equal(add(store, '2028-10-06', '2028-10-06').from, '2028-10-06', 'just inside two years')
})

test('the note is plain text of at most 200 characters, without line breaks or control characters', () => {
  const { store } = setup()
  assert.equal(add(store, '2026-10-20', '2026-10-20', 'x'.repeat(200)).note.length, 200)
  assert.equal(code(() => add(store, '2026-10-21', '2026-10-21', 'x'.repeat(201))), 'invalid')
  for (const bad of ['twee\nregels', 'tab\there', 'bel\u0007', 'nul\u0000', 'e\u2028f', 5, {}, ['a']]) {
    assert.equal(code(() => add(store, '2026-10-22', '2026-10-22', bad)), 'invalid', JSON.stringify(bad))
  }
  assert.equal(add(store, '2026-10-23', '2026-10-23', '   ').note, '', 'spaces only is no note')
  assert.equal(add(store, '2026-10-24', '2026-10-24', 'Tandarts <b>10:00</b> & "kind"').note, 'Tandarts <b>10:00</b> & "kind"', 'kept as typed: the screen shows text, never HTML')
  assert.equal(store.list().length, 3, 'only the three valid ones were kept')
})

test('periods of one person may not overlap, touching is fine, another person is independent', () => {
  const { store } = setup()
  add(store, '2026-10-12', '2026-10-16')
  for (const [from, to] of [['2026-10-12', '2026-10-16'], ['2026-10-14', '2026-10-14'], ['2026-10-10', '2026-10-12'], ['2026-10-16', '2026-10-20'], ['2026-10-01', '2026-10-30']]) {
    assert.equal(code(() => add(store, from, to)), 'conflict', `${from} - ${to}`)
  }
  assert.equal(add(store, '2026-10-17', '2026-10-18').from, '2026-10-17', 'the day after')
  assert.equal(add(store, '2026-10-09', '2026-10-11').from, '2026-10-09', 'the day before')
  assert.equal(add(store, '2026-10-12', '2026-10-16', '', { accountId: 'u_sanne' }).accountId, 'u_sanne')
  assert.equal(store.list().length, 4)
})

test('a person has at most 50 periods that have not ended yet', () => {
  const { store } = setup()
  for (let day = 0; day < 50; day++) {
    const date = new Date(Date.UTC(2026, 9, 10 + day * 2)).toISOString().slice(0, 10)
    add(store, date, date)
  }
  assert.equal(code(() => add(store, '2027-06-01', '2027-06-01')), 'limit')
  assert.equal(add(store, '2027-06-01', '2027-06-01', '', { accountId: 'u_sanne' }).accountId, 'u_sanne', 'another person is not affected')
  assert.equal(store.list().length, 51)
})

test('periods that have ended do not count towards the limit of 50', () => {
  const { store, clock } = setup()
  for (let day = 0; day < 50; day++) {
    const date = new Date(Date.UTC(2026, 9, 7 + day)).toISOString().slice(0, 10)
    add(store, date, date)
  }
  assert.equal(code(() => add(store, '2027-06-01', '2027-06-01')), 'limit')
  clock.now = new Date('2026-10-30T10:00:00Z') // 23 of them have ended, they are still in the file for a while
  assert.equal(store.list().length, 50)
  assert.equal(add(store, '2027-06-01', '2027-06-01').from, '2027-06-01')
})

test('removing: only the owner removes a period, and anything else is "not found"', () => {
  const { store } = setup()
  const own = add(store, '2026-10-12', '2026-10-12')
  assert.equal(code(() => store.remove(own.id, 'u_sanne')), 'not_found', 'the period of someone else looks like it does not exist')
  assert.equal(code(() => store.remove('p_99', 'u_jan')), 'not_found')
  assert.equal(code(() => store.remove('', 'u_jan')), 'not_found')
  assert.equal(store.list().length, 1)
  store.remove(own.id, 'u_jan')
  assert.deepEqual(store.list(), [])
  assert.equal(code(() => store.remove(own.id, 'u_jan')), 'not_found', 'twice is not found, not a crash')
})

test('removing all periods of an account (when the account goes away) leaves the others', () => {
  const { store } = setup()
  add(store, '2026-10-12', '2026-10-12')
  add(store, '2026-10-12', '2026-10-12', '', { accountId: 'u_sanne' })
  store.removeAllOf('u_jan')
  assert.deepEqual(store.list().map((period) => period.accountId), ['u_sanne'])
})

test('periods that ended more than 30 days ago are forgotten at the next save, newer ones stay', () => {
  const { store, clock } = setup()
  add(store, '2026-10-07', '2026-10-09', 'oud')
  add(store, '2026-12-01', '2026-12-03', 'nieuw')
  clock.now = new Date('2026-11-07T10:00:00Z') // the first ended 29 days ago
  add(store, '2027-01-01', '2027-01-01')
  assert.deepEqual(store.list().map((period) => period.note), ['oud', 'nieuw', ''], '29 days: still there')
  clock.now = new Date('2026-11-10T10:00:00Z') // 32 days
  add(store, '2027-02-01', '2027-02-01')
  assert.deepEqual(store.list().map((period) => period.note), ['nieuw', '', ''])
})

test('the file is JSON with a version, and a damaged file is refused as a whole instead of being repaired', () => {
  const { store, file } = setup()
  add(store, '2026-10-12', '2026-10-13', 'x')
  const written = JSON.parse(file.text as string)
  assert.equal(written.version, 1)
  assert.equal(written.periods.length, 1)

  const broken = (text: string) => {
    const damaged = setup()
    damaged.file.text = text
    assert.throws(() => damaged.store.list(), AvailabilityFileError, text.slice(0, 60))
    assert.throws(() => damaged.store.add({ ...jan, from: '2026-10-12', to: '2026-10-12' }), AvailabilityFileError)
    assert.equal(damaged.file.text, text, 'nothing was written over it')
  }
  const good = { id: 'p_1', accountId: 'u_jan', from: '2026-10-12', to: '2026-10-13', note: '', createdAt: '2026-10-07T10:00:00.000Z' }
  broken('geen json')
  broken('[]')
  broken(JSON.stringify({ version: 2, periods: [] }))
  broken(JSON.stringify({ version: 1 }))
  broken(JSON.stringify({ version: 1, periods: [{ ...good, from: '2026-02-30' }] }))
  broken(JSON.stringify({ version: 1, periods: [{ ...good, to: '2026-10-11' }] }))
  broken(JSON.stringify({ version: 1, periods: [{ ...good, note: 'x'.repeat(201) }] }))
  broken(JSON.stringify({ version: 1, periods: [{ ...good, accountId: '' }] }))
  broken(JSON.stringify({ version: 1, periods: [{ ...good, id: undefined }] }))
  broken(JSON.stringify({ version: 1, periods: [good, good] }))
  const fine = setup()
  fine.file.text = JSON.stringify({ version: 1, periods: [good] })
  assert.equal(fine.store.list()[0].id, 'p_1')
})

test('without a given id generator the ids are different every time', () => {
  const file = { text: null as string | null }
  const store = createAvailabilityStore({ io: { read: () => file.text, write: (text) => (file.text = text) }, now: () => new Date('2026-10-07T10:00:00Z') })
  const first = store.add({ ...jan, from: '2026-10-12', to: '2026-10-12' })
  const second = store.add({ ...jan, from: '2026-10-13', to: '2026-10-13' })
  assert.notEqual(first.id, second.id)
  assert.match(first.id, /^p_[0-9a-f]{32}$/)
})

test('what is known of the record in Odoo is kept with the period, and can be changed or cleared', () => {
  const { store, file } = setup()
  const period = add(store, '2026-10-12', '2026-10-13')
  assert.equal(period.odoo, undefined, 'a new period is only in the dashboard')
  store.setOdoo(period.id, { employeeId: 7, state: 'synced', leaveId: 901, verified: true })
  assert.deepEqual(store.list()[0].odoo, { employeeId: 7, state: 'synced', leaveId: 901, verified: true })
  store.setOdoo(period.id, { employeeId: 7, state: 'failed', message: 'Odoo heeft het geweigerd.' })
  assert.deepEqual(store.list()[0].odoo, { employeeId: 7, state: 'failed', message: 'Odoo heeft het geweigerd.' })
  store.setOdoo(period.id, { employeeId: 7, state: 'unknown', message: 'Niet zeker.' })
  assert.equal(store.list()[0].odoo?.state, 'unknown')
  store.setOdoo(period.id, null)
  assert.equal(store.list()[0].odoo, undefined)
  assert.equal('odoo' in JSON.parse(file.text as string).periods[0], false, 'nothing about Odoo in the file')
  assert.equal(code(() => store.setOdoo('p_99', null)), 'not_found')
})

test('finding a period: only for its owner', () => {
  const { store } = setup()
  const own = add(store, '2026-10-12', '2026-10-13')
  assert.equal(store.find(own.id, 'u_jan')?.id, own.id)
  assert.equal(store.find(own.id, 'u_sanne'), undefined)
  assert.equal(store.find('p_99', 'u_jan'), undefined)
})

test('the part about Odoo in the file is checked too', () => {
  const good = { id: 'p_1', accountId: 'u_jan', from: '2026-10-12', to: '2026-10-13', note: '', createdAt: '2026-10-07T10:00:00.000Z' }
  const broken = (odoo: unknown) => {
    const damaged = setup()
    damaged.file.text = JSON.stringify({ version: 1, periods: [{ ...good, odoo }] })
    assert.throws(() => damaged.store.list(), AvailabilityFileError, JSON.stringify(odoo))
  }
  for (const odoo of [
    'synced', 5, [], { state: 'synced', leaveId: 901, verified: true }, { employeeId: 0, state: 'synced', leaveId: 901, verified: true },
    { employeeId: 7, state: 'synced', leaveId: 0, verified: true }, { employeeId: 7, state: 'synced', leaveId: 901 }, { employeeId: 7, state: 'synced', leaveId: 901, verified: 'ja' },
    { employeeId: 7, state: 'failed' }, { employeeId: 7, state: 'unknown', message: 5 }, { employeeId: 7, state: 'failed', message: 'x'.repeat(301) }, { employeeId: 7, state: 'klaar', leaveId: 901, verified: true },
  ]) broken(odoo)
  const fine = setup()
  fine.file.text = JSON.stringify({ version: 1, periods: [{ ...good, odoo: { employeeId: 7, state: 'synced', leaveId: 901, verified: false } }] })
  assert.equal(fine.store.list()[0].odoo?.state, 'synced')
})
