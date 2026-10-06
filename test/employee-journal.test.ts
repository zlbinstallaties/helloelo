import test from 'node:test'
import assert from 'node:assert/strict'
import type { AccountIo } from '../src/lib/accounts.ts'
import { createJournal, JournalError, JournalFileError } from '../src/lib/employee-journal.ts'

const REQUEST = 'req-0123456789abcdef'

function memory(initial: string | null = null) {
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

function journal(initial: string | null = null, start = '2026-10-06T10:00:00.000Z') {
  const { io, state } = memory(initial)
  const clock = { now: new Date(start) }
  return { journal: createJournal({ io, now: () => clock.now }), state, io, clock }
}

const begin = (j: ReturnType<typeof journal>['journal'], requestId = REQUEST) =>
  j.begin({ requestId, name: 'Jan de Vries', username: 'jan', by: 'u_planner' })

test('a new journal is empty, also without a file', () => {
  assert.deepEqual(journal().journal.list(), [])
  assert.equal(journal().journal.get(REQUEST), undefined)
})

test('begin records the request before anything happens: who, what and when', () => {
  const { journal: j, state } = journal()
  const entry = begin(j)
  assert.deepEqual(entry, {
    requestId: REQUEST, state: 'creating', name: 'Jan de Vries', username: 'jan', by: 'u_planner',
    at: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z',
  })
  assert.deepEqual(j.get(REQUEST), entry)
  assert.equal(state.writes, 1)
  assert.ok(!(state.text ?? '').includes('password'), 'no password is ever written')
})

test('a request id can be recorded once', () => {
  const { journal: j } = journal()
  begin(j)
  assert.throws(() => begin(j), (error) => error instanceof JournalError && error.code === 'exists')
})

test('a request goes creating, created, done; each step is saved and keeps what came before', () => {
  const { journal: j, clock } = journal()
  begin(j)
  clock.now = new Date('2026-10-06T10:00:05.000Z')
  assert.equal(j.markCreated(REQUEST, 41).employeeId, 41)
  clock.now = new Date('2026-10-06T10:00:09.000Z')
  const done = j.markDone(REQUEST, 'u_new')
  assert.deepEqual(done, {
    requestId: REQUEST, state: 'done', name: 'Jan de Vries', username: 'jan', by: 'u_planner',
    at: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:09.000Z', employeeId: 41, verified: false, planningRoles: 0, accountId: 'u_new',
  })
})

test('the steps cannot be done out of order, so a state never lies', () => {
  const { journal: j } = journal()
  begin(j)
  assert.throws(() => j.markDone(REQUEST, 'u_new'), JournalError, 'done without created')
  j.markCreated(REQUEST, 41)
  assert.throws(() => j.markCreated(REQUEST, 42), JournalError, 'created twice')
  assert.throws(() => j.remove(REQUEST), JournalError, 'an employee exists: the entry stays')
  j.markDone(REQUEST, 'u_new')
  assert.throws(() => j.markUnknown(REQUEST), JournalError, 'done is final')
  assert.throws(() => j.markCreated('req-unknown-0123456789', 1), (error) => error instanceof JournalError && error.code === 'not_found')
})

test('an unknown outcome is kept and can only be looked at, never run again by this journal', () => {
  const { journal: j } = journal()
  begin(j)
  assert.equal(j.markUnknown(REQUEST).state, 'unknown')
  assert.throws(() => j.markCreated(REQUEST, 41), JournalError)
  assert.throws(() => j.remove(REQUEST), JournalError)
  assert.equal(j.get(REQUEST)?.state, 'unknown')
})

test('a request that Odoo refused is removed, so that it can be tried again', () => {
  const { journal: j } = journal()
  begin(j)
  j.remove(REQUEST)
  assert.equal(j.get(REQUEST), undefined)
  assert.ok(begin(j))
})

test('what was written is there for the next journal on the same file', () => {
  const { journal: j, io } = journal()
  begin(j)
  j.markCreated(REQUEST, 41)
  const again = createJournal({ io })
  assert.equal(again.get(REQUEST)?.employeeId, 41)
  assert.equal(again.get(REQUEST)?.state, 'created')
})

test('a file that is not valid is an error and is left alone: nothing is started on top of it', () => {
  for (const text of ['{ kapot', '[]', '{"version":2,"requests":[]}', '{"version":1}', '{"version":1,"requests":[{"requestId":"x"}]}', '']) {
    const { journal: j, state } = journal(text)
    assert.throws(() => j.list(), JournalFileError, text)
    assert.throws(() => begin(j), JournalFileError, text)
    assert.equal(state.text, text)
    assert.equal(state.writes, 0)
  }
})

test('old finished requests are dropped when something is written; open and unsure ones stay', () => {
  const { journal: j, clock } = journal()
  begin(j, 'req-old-done-0123456789')
  j.markCreated('req-old-done-0123456789', 1)
  j.markDone('req-old-done-0123456789', 'u_1')
  begin(j, 'req-old-unknown-0123456789')
  j.markUnknown('req-old-unknown-0123456789')
  begin(j, 'req-old-created-0123456789')
  j.markCreated('req-old-created-0123456789', 3)
  clock.now = new Date('2026-11-10T10:00:00.000Z') // more than 30 days later
  begin(j, 'req-new-0123456789abcdef')
  assert.deepEqual(j.list().map((entry) => entry.requestId).sort(), ['req-new-0123456789abcdef', 'req-old-created-0123456789', 'req-old-unknown-0123456789'])
})

test('a recent finished request is kept: a repeat of it must still be recognised', () => {
  const { journal: j, clock } = journal()
  begin(j)
  j.markCreated(REQUEST, 41)
  j.markDone(REQUEST, 'u_new')
  clock.now = new Date('2026-10-20T10:00:00.000Z')
  begin(j, 'req-another-0123456789')
  assert.equal(j.get(REQUEST)?.state, 'done')
})

test('verification is remembered, and a user name can change only while the account is still missing', () => {
  const { journal: j } = journal()
  begin(j)
  assert.throws(() => j.setUsername(REQUEST, 'anders'), JournalError, 'not before the employee exists')
  j.markCreated(REQUEST, 41, true)
  assert.equal(j.get(REQUEST)?.verified, true)
  assert.equal(j.setUsername(REQUEST, 'jan.devries').username, 'jan.devries')
  j.markDone(REQUEST, 'u_new')
  assert.throws(() => j.setUsername(REQUEST, 'weer-anders'), JournalError, 'not when everything is done')
  begin(j, 'req-second-0123456789')
  j.markCreated('req-second-0123456789', 42)
  assert.equal(j.get('req-second-0123456789')?.verified, false, 'not verified unless said so')
})

test('an unsure request can remember the employee that is known to exist', () => {
  const { journal: j } = journal()
  begin(j)
  const entry = j.markUnknown(REQUEST, 41)
  assert.equal(entry.state, 'unknown')
  assert.equal(entry.employeeId, 41)
})

test('the number of confirmed planning roles is saved with the employee, and a bad value in the file is an error', () => {
  const { journal: j } = journal()
  begin(j)
  const created = j.markCreated(REQUEST, 41, true, 2)
  assert.equal(created.planningRoles, 2)
  assert.equal(j.get(REQUEST)?.planningRoles, 2)
  assert.equal(createJournal({ io: journal().io }).list().length, 0)
  // An entry written before this setting existed has none; a wrong value is refused, not guessed.
  const entry = { requestId: REQUEST, state: 'created', name: 'Jan', username: 'jan', by: 'u', at: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z', employeeId: 41 }
  const file = (extra: Record<string, unknown>) => JSON.stringify({ version: 1, requests: [{ ...entry, ...extra }] })
  assert.equal(journal(file({})).journal.get(REQUEST)?.planningRoles, undefined)
  for (const planningRoles of [-1, 1.5, '2', 100, null]) {
    assert.throws(() => journal(file({ planningRoles })).journal.list(), JournalFileError, JSON.stringify(planningRoles))
  }
})
