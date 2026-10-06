import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountStore } from '../src/lib/accounts.ts'
import type { AccountIo } from '../src/lib/accounts.ts'
import type { User } from '../src/lib/authorization.ts'
import { createJournal } from '../src/lib/employee-journal.ts'
import { createTechnician } from '../src/lib/employee-service.ts'
import type { TechnicianResult } from '../src/lib/employee-service.ts'
import type { GatewayOutcome } from '../src/lib/gateway-employee.ts'

const REQUEST = 'req-0123456789abcdef'
const GENERATED = 'Tijd-Elijk-Pass-Word'
const planner: User = { id: 'u_planner', username: 'planner', name: 'Petra', role: 'admin', personId: null, emergency: false }
const monteur: User = { id: 'u_jan', username: 'jan', name: 'Jan', role: 'monteur', personId: 'employee:7', emergency: false }

function memory() {
  const state = { text: null as string | null, failWrites: 0, writes: 0, failAtWrite: null as number | null }
  const io: AccountIo = {
    read: () => state.text,
    write: (text) => {
      state.writes += 1
      if (state.failAtWrite === state.writes) throw new Error('schijf vol')
      if (state.failWrites > 0) {
        state.failWrites -= 1
        throw new Error('schijf vol')
      }
      state.text = text
    },
  }
  return { io, state }
}

function setup() {
  const accountsFile = memory()
  const journalFile = memory()
  const clock = { now: new Date('2026-10-06T10:00:00.000Z') }
  const accounts = createAccountStore({ io: accountsFile.io, now: () => clock.now, reservedUsernames: ['noodadmin'] })
  const journal = createJournal({ io: journalFile.io, now: () => clock.now })
  const gateway = {
    calls: [] as Array<{ requestId: string; name: string }>,
    seenInJournal: [] as Array<string | undefined>,
    outcome: (): GatewayOutcome | Promise<GatewayOutcome> => ({ kind: 'created', id: 41, verified: true, replayed: false }),
  }
  const deps = {
    accounts,
    journal,
    now: () => clock.now,
    generatePassword: () => GENERATED,
    createEmployee: async (input: { requestId: string; name: string }) => {
      gateway.calls.push(input)
      gateway.seenInJournal.push(journal.get(input.requestId)?.state)
      return gateway.outcome()
    },
  }
  const run = (user: User, input: Record<string, unknown> = {}) =>
    createTechnician(deps, user, { requestId: REQUEST, name: 'Jan de Vries', username: 'jan', ...input })
  return { run, accounts, journal, gateway, accountsFile, journalFile, clock }
}

function ok(result: TechnicianResult) {
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error('unreachable')
  return result
}

function refused(result: TechnicianResult, status: number, message?: RegExp) {
  assert.equal(result.ok, false, JSON.stringify(result))
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.status, status, result.error)
  if (message) assert.match(result.error, message)
  return result
}

test('a planner adds a technician: one employee in Odoo, then a portal account linked by the employee id', async () => {
  const { run, accounts, gateway, journal } = setup()
  const result = ok(await run(planner))
  assert.equal(result.status, 201)
  assert.equal(result.employeeId, 41)
  assert.equal(result.verified, true)
  assert.equal(result.replayed, false)
  assert.equal(result.password, GENERATED)
  assert.deepEqual(result.account, {
    id: result.account?.id, username: 'jan', name: 'Jan de Vries', role: 'monteur', personId: 'employee:41', disabled: false,
    createdAt: '2026-10-06T10:00:00.000Z',
  })
  assert.deepEqual(gateway.calls, [{ requestId: REQUEST, name: 'Jan de Vries' }], 'only the request id and the name go to the gateway')
  assert.ok(accounts.authenticate('jan', GENERATED), 'the technician can log in with the password that is shown once')
  assert.equal(journal.get(REQUEST)?.state, 'done')
  assert.equal(journal.get(REQUEST)?.employeeId, 41)
  assert.equal(journal.get(REQUEST)?.accountId, result.account?.id)
})

test('the portal account is linked by the stable employee id, never by the name', async () => {
  const { run, accounts, gateway } = setup()
  const first = ok(await run(planner))
  gateway.outcome = () => ({ kind: 'created', id: 42, verified: true, replayed: false })
  const second = ok(await run(planner, { requestId: 'req-second-0123456789', username: 'jan2' }))
  assert.equal(first.account?.name, second.account?.name, 'two people with the same name')
  assert.deepEqual([first.account?.personId, second.account?.personId], ['employee:41', 'employee:42'])
  assert.deepEqual(accounts.list().map((account) => account.personId).sort(), ['employee:41', 'employee:42'])
  assert.ok(accounts.list().every((account) => account.personId?.startsWith('employee:')))
})

test('the technician gets no Odoo account of any kind: only a portal account, and the gateway is asked for an employee only', async () => {
  const { run, gateway, accountsFile } = setup()
  ok(await run(planner))
  assert.equal(gateway.calls.length, 1)
  assert.deepEqual(Object.keys(gateway.calls[0]).sort(), ['name', 'requestId'])
  assert.ok(!(accountsFile.state.text ?? '').includes('res.users'))
})

test('a monteur cannot add a technician: refused, nothing asked of Odoo, nothing written', async () => {
  const { run, gateway, journalFile, accountsFile, accounts } = setup()
  refused(await run(monteur), 403, /geen toegang/i)
  assert.equal(gateway.calls.length, 0)
  assert.equal(journalFile.state.text, null)
  assert.equal(accountsFile.state.text, null)
  assert.deepEqual(accounts.list(), [])
})

test('the account is checked before Odoo is asked: a taken user name or an invalid input creates no employee', async () => {
  const { run, accounts, gateway, journalFile } = setup()
  accounts.create({ username: 'jan', name: 'Jan', role: 'monteur', personId: 'employee:7', password: 'een-goed-wachtwoord' })
  refused(await run(planner), 409, /bestaat al/)
  refused(await run(planner, { username: 'noodadmin' }), 409, /bestaat al/)
  refused(await run(planner, { username: 'a b' }), 400, /gebruikersnaam/i)
  refused(await run(planner, { name: '', username: 'els' }), 400, /naam/)
  refused(await run(planner, { name: 'x'.repeat(81), username: 'els' }), 400, /naam/)
  refused(await run(planner, { name: 'Jan\nde Vries', username: 'els' }), 400, /naam/)
  for (const requestId of [undefined, '', 'kort', 'x'.repeat(65), 'met spatie 0123456789', 5, null]) {
    refused(await run(planner, { requestId, username: 'els' }), 400, /aanvraag/i)
  }
  assert.equal(gateway.calls.length, 0)
  assert.equal(journalFile.state.text, null)
})

test('the request is written down before Odoo is asked', async () => {
  const { run, gateway } = setup()
  ok(await run(planner))
  assert.deepEqual(gateway.seenInJournal, ['creating'])
})

test('if the request cannot be written down Odoo is not asked at all', async () => {
  const { run, gateway, journalFile } = setup()
  journalFile.state.failWrites = 1
  refused(await run(planner), 500)
  assert.equal(gateway.calls.length, 0)
})

test('Odoo refuses: an error, no account, and the same request may be tried again', async () => {
  const { run, gateway, accounts, journal } = setup()
  gateway.outcome = () => ({ kind: 'rejected', message: 'Odoo heeft het aanmaken geweigerd. Er is niets aangemaakt.' })
  const result = refused(await run(planner), 502, /geweigerd/)
  assert.equal(result.employeeId, undefined)
  assert.deepEqual(accounts.list(), [], 'no account for an employee that does not exist')
  assert.equal(journal.get(REQUEST), undefined)
  gateway.outcome = () => ({ kind: 'created', id: 41, verified: true, replayed: false })
  ok(await run(planner))
  assert.equal(gateway.calls.length, 2)
  assert.equal(accounts.list().length, 1)
})

test('the action is not enabled on the server: an error that says so, nothing created', async () => {
  const { run, gateway, accounts, journal } = setup()
  gateway.outcome = () => ({ kind: 'not_enabled', message: 'Het aanmaken van monteurs in Odoo staat niet aan op de server.' })
  refused(await run(planner), 503, /staat niet aan/)
  assert.deepEqual(accounts.list(), [])
  assert.equal(journal.get(REQUEST), undefined)
})

test('no usable answer: an error, no account, and a repeat is not sent to Odoo again', async () => {
  const { run, gateway, accounts, journal } = setup()
  gateway.outcome = () => ({ kind: 'unknown', message: 'Het is niet zeker of de medewerker is aangemaakt: controleer dat in Odoo.' })
  refused(await run(planner), 504, /niet zeker/)
  assert.deepEqual(accounts.list(), [])
  assert.equal(journal.get(REQUEST)?.state, 'unknown')
  for (let i = 0; i < 3; i++) refused(await run(planner), 409, /niet zeker|controleer/i)
  assert.equal(gateway.calls.length, 1, 'Odoo was asked once')
})

test('an employee that Odoo made wrongly is reported with its id, gets no account and is not asked again', async () => {
  const { run, gateway, accounts, journal } = setup()
  gateway.outcome = () => ({ kind: 'invariant', id: 41, message: 'In Odoo is medewerker 41 aangemaakt, maar niet zoals bedoeld.' })
  const result = refused(await run(planner), 500, /41/)
  assert.equal(result.employeeId, 41)
  assert.deepEqual(accounts.list(), [])
  assert.equal(journal.get(REQUEST)?.state, 'unknown')
  refused(await run(planner), 409)
  assert.equal(gateway.calls.length, 1)
})

test('a repeat of a finished request gives the same answer without a password and without a second employee or account', async () => {
  const { run, gateway, accounts } = setup()
  const first = ok(await run(planner))
  const again = ok(await run(planner))
  assert.equal(again.status, 200)
  assert.equal(again.replayed, true)
  assert.equal(again.employeeId, 41)
  assert.equal(again.password, null, 'the password was shown once')
  assert.equal(again.account?.id, first.account?.id)
  assert.equal(gateway.calls.length, 1)
  assert.equal(accounts.list().length, 1)
})

test('a repeat after the account was removed still makes nothing new', async () => {
  const { run, gateway, accounts } = setup()
  const first = ok(await run(planner))
  accounts.remove(first.account!.id)
  const again = ok(await run(planner))
  assert.equal(again.account, null)
  assert.equal(again.replayed, true)
  assert.equal(gateway.calls.length, 1)
  assert.deepEqual(accounts.list(), [])
})

test('the same request id for another name or user name is not a repeat', async () => {
  const { run, gateway } = setup()
  ok(await run(planner))
  refused(await run(planner, { name: 'Sanne Bakker' }), 409, /andere/)
  refused(await run(planner, { username: 'sanne' }), 409, /andere/)
  assert.equal(gateway.calls.length, 1)
})

test('a second request while the first still runs is refused', async () => {
  const { run, gateway, accounts } = setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  gateway.outcome = async () => {
    await gate
    return { kind: 'created', id: 41, verified: true, replayed: false }
  }
  const first = run(planner)
  await new Promise((resolve) => setTimeout(resolve, 10))
  refused(await run(planner), 409, /wordt al verwerkt/)
  release()
  ok(await first)
  assert.equal(gateway.calls.length, 1)
  assert.equal(accounts.list().length, 1)
})

test('a request that was left "creating" for a long time (a crash) is treated as unsure, never as safe to repeat', async () => {
  const { run, gateway, journal, clock } = setup()
  journal.begin({ requestId: REQUEST, name: 'Jan de Vries', username: 'jan', by: 'u_planner' })
  clock.now = new Date('2026-10-06T10:05:00.000Z')
  refused(await run(planner), 409, /niet zeker|controleer/i)
  assert.equal(journal.get(REQUEST)?.state, 'unknown')
  assert.equal(gateway.calls.length, 0)
})

test('the account could not be made after Odoo confirmed: the employee id is reported, and the same request finishes the job', async () => {
  const { run, gateway, accounts, accountsFile, journal } = setup()
  accountsFile.state.failWrites = 1
  const result = refused(await run(planner), 500, /41/)
  assert.equal(result.employeeId, 41)
  assert.equal(journal.get(REQUEST)?.state, 'created')
  assert.deepEqual(accounts.list(), [])
  const finished = ok(await run(planner))
  assert.equal(finished.status, 201)
  assert.equal(finished.account?.personId, 'employee:41')
  assert.equal(finished.password, GENERATED)
  assert.equal(gateway.calls.length, 1, 'Odoo was not asked a second time')
  assert.equal(journal.get(REQUEST)?.state, 'done')
})

test('the user name was taken in the meantime: the employee exists, and another user name finishes the job', async () => {
  const { run, gateway, accounts, journal } = setup()
  gateway.outcome = () => {
    accounts.create({ username: 'jan', name: 'Andere Jan', role: 'monteur', personId: 'employee:7', password: 'een-goed-wachtwoord' })
    return { kind: 'created', id: 41, verified: true, replayed: false }
  }
  const result = refused(await run(planner), 409, /41/)
  assert.equal(result.employeeId, 41)
  assert.equal(journal.get(REQUEST)?.state, 'created')
  const finished = ok(await run(planner, { username: 'jan.devries' }))
  assert.equal(finished.account?.username, 'jan.devries')
  assert.equal(finished.account?.personId, 'employee:41')
  assert.equal(gateway.calls.length, 1)
  assert.equal(journal.get(REQUEST)?.username, 'jan.devries')
  refused(await run(planner, { name: 'Een Ander' }), 409, /andere/)
})

test('the journal could not record the answer of Odoo: the employee id is reported and no account is made', async () => {
  const { run, gateway, journalFile, accounts } = setup()
  gateway.outcome = () => {
    journalFile.state.failWrites = 1
    return { kind: 'created', id: 41, verified: true, replayed: false }
  }
  const result = refused(await run(planner), 500, /41/)
  assert.equal(result.employeeId, 41)
  assert.deepEqual(accounts.list(), [])
})

test('a damaged file stops everything before Odoo is asked', async () => {
  for (const which of ['accountsFile', 'journalFile'] as const) {
    const setupResult = setup()
    setupResult[which].state.text = '{ kapot'
    refused(await setupResult.run(planner), 500, /ongeldig/)
    assert.equal(setupResult.gateway.calls.length, 0, which)
  }
})

test('the password is shown once and is nowhere on disk', async () => {
  const { run, accountsFile, journalFile } = setup()
  const result = ok(await run(planner))
  assert.equal(result.password, GENERATED)
  assert.ok(!(accountsFile.state.text ?? '').includes(GENERATED))
  assert.ok(!(journalFile.state.text ?? '').includes(GENERATED))
  assert.ok(!(journalFile.state.text ?? '').toLowerCase().includes('password'))
})

test('the journal says who asked', async () => {
  const { run, journal } = setup()
  ok(await run(planner))
  assert.equal(journal.get(REQUEST)?.by, 'u_planner')
})

test('the account was made but the journal could not say so: the planner gets the password, and a repeat finds the account', async () => {
  const { run, gateway, accounts, journal, journalFile } = setup()
  // The journal is written three times: begin, created, done. The last one fails.
  journalFile.state.failAtWrite = journalFile.state.writes + 3
  const first = ok(await run(planner))
  assert.equal(first.status, 201)
  assert.equal(first.password, GENERATED)
  assert.equal(journal.get(REQUEST)?.state, 'created', 'the journal still says that only the account is missing')
  const again = ok(await run(planner))
  assert.equal(again.replayed, true)
  assert.equal(again.account?.id, first.account?.id)
  assert.equal(again.password, null)
  assert.equal(accounts.list().length, 1, 'no second account')
  assert.equal(gateway.calls.length, 1, 'no second employee')
  assert.equal(journal.get(REQUEST)?.state, 'done')
})

test('whether the employee was verified is remembered, also across a half done request and a repeat', async () => {
  const { run, gateway, accountsFile, journal } = setup()
  gateway.outcome = () => ({ kind: 'created', id: 41, verified: false, replayed: false })
  accountsFile.state.failWrites = 1
  refused(await run(planner), 500, /41/)
  assert.equal(journal.get(REQUEST)?.verified, false)
  const finished = ok(await run(planner))
  assert.equal(finished.verified, false, 'still not verified after finishing the account')
  assert.equal(ok(await run(planner)).verified, false, 'and in a repeat')
  const verifiedOne = setup()
  assert.equal(ok(await verifiedOne.run(planner)).verified, true)
  assert.equal(ok(await verifiedOne.run(planner)).verified, true)
})

test('the answer says whether the same request may be sent again: only when nothing is unclear', async () => {
  const retry = (result: TechnicianResult) => (result.ok ? null : result.retry)
  const safe = setup()
  safe.gateway.outcome = () => ({ kind: 'rejected', message: 'Geweigerd.' })
  assert.equal(retry(await safe.run(planner)), 'safe', 'refused by Odoo')
  assert.equal(retry(await safe.run(planner, { username: 'a b' })), 'safe', 'input')
  assert.equal(retry(await setup().run(monteur)), 'safe', 'rights')

  const notEnabled = setup()
  notEnabled.gateway.outcome = () => ({ kind: 'not_enabled', message: 'Uit.' })
  assert.equal(retry(await notEnabled.run(planner)), 'safe')

  const unknown = setup()
  unknown.gateway.outcome = () => ({ kind: 'unknown', message: 'Onbekend.' })
  assert.equal(retry(await unknown.run(planner)), 'blocked', 'first answer')
  assert.equal(retry(await unknown.run(planner)), 'blocked', 'a repeat')

  const invariant = setup()
  invariant.gateway.outcome = () => ({ kind: 'invariant', id: 41, message: 'Niet zoals bedoeld.' })
  assert.equal(retry(await invariant.run(planner)), 'blocked')
  assert.equal(retry(await invariant.run(planner)), 'blocked', 'a repeat')

  const half = setup()
  half.accountsFile.state.failWrites = 1
  assert.equal(retry(await half.run(planner)), 'safe', 'only the account is missing: the same request finishes it')

  const stale = setup()
  stale.journal.begin({ requestId: REQUEST, name: 'Jan de Vries', username: 'jan', by: 'u_planner' })
  stale.clock.now = new Date('2026-10-06T10:05:00.000Z')
  assert.equal(retry(await stale.run(planner)), 'blocked', 'a request that was cut off')

  const busy = setup()
  busy.journal.begin({ requestId: REQUEST, name: 'Jan de Vries', username: 'jan', by: 'u_planner' })
  assert.equal(retry(await busy.run(planner)), 'safe', 'still running: waiting is safe')
})
