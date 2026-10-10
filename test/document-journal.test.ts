import test from 'node:test'
import assert from 'node:assert/strict'
import type { AccountIo } from '../src/lib/accounts.ts'
import { createDocumentJournal, DocumentJournalError, DocumentJournalFileError, requestIdFor } from '../src/lib/document-journal.ts'

const SUBMISSION = 'f3b1c2d4-5e6f-4a7b-8c9d-0123456789ab'

function setup(start = '2026-10-08T10:00:00.000Z') {
  const state = { text: null as string | null }
  const io: AccountIo = { read: () => state.text, write: (text) => (state.text = text) }
  const clock = { now: new Date(start) }
  const journal = createDocumentJournal({ io, now: () => clock.now })
  return { journal, state, clock }
}

const entry = { submissionId: SUBMISSION, type: 'schouw' as const, appointmentId: 'slot-12', by: 'acc-1' }

test('begin writes the entry before Odoo is asked, and keeps no customer, no file and no answers', () => {
  const { journal, state } = setup()
  const begun = journal.begin(entry)
  assert.equal(begun.state, 'sending')
  assert.equal(begun.requestId, requestIdFor(SUBMISSION), 'the same submission always gives the same request id')
  assert.notEqual(requestIdFor(SUBMISSION), requestIdFor(`${SUBMISSION}0`))
  assert.match(begun.requestId, /^[A-Za-z0-9_-]{16,64}$/, 'a request id the gateway accepts')
  const text = state.text ?? ''
  for (const forbidden of ['pdf', 'signature', 'answers', 'customer', 'foto']) assert.ok(!text.includes(forbidden), forbidden)
  assert.deepEqual(journal.get(SUBMISSION), begun)
})

test('the same submission cannot begin twice; another one can', () => {
  const { journal } = setup()
  journal.begin(entry)
  assert.throws(() => journal.begin(entry), (error) => error instanceof DocumentJournalError && error.code === 'exists')
  journal.begin({ ...entry, submissionId: 'a-different-submission-0001' })
  assert.equal(journal.list().length, 2)
})

test('posted: the entry keeps whether the note was placed, and a second answer is refused', () => {
  const { journal } = setup()
  journal.begin(entry)
  const posted = journal.markPosted(SUBMISSION, true)
  assert.deepEqual([posted.state, posted.noted], ['posted', true])
  assert.throws(() => journal.markPosted(SUBMISSION, true), (error) => error instanceof DocumentJournalError && error.code === 'state')
  assert.throws(() => journal.markUnknown(SUBMISSION), (error) => error instanceof DocumentJournalError && error.code === 'state')
  const lost = 'lost-submission-00000002'
  journal.begin({ ...entry, submissionId: lost })
  journal.markUnknown(lost)
  assert.throws(() => journal.markPosted(lost, true), (error) => error instanceof DocumentJournalError && error.code === 'state', 'an unsure one is settled by a person, not by a late answer')
})

test('unknown stays until somebody has looked; a refused one is removed so the phone can try again', () => {
  const { journal } = setup()
  journal.begin(entry)
  assert.equal(journal.markUnknown(SUBMISSION).state, 'unknown')
  assert.throws(() => journal.remove(SUBMISSION), (error) => error instanceof DocumentJournalError && error.code === 'state')
  const other = 'another-submission-0000001'
  journal.begin({ ...entry, submissionId: other })
  journal.remove(other)
  assert.equal(journal.get(other), undefined)
  assert.equal(journal.get(SUBMISSION)?.state, 'unknown')
})

test('an entry that has been "sending" for minutes is unknown: the server may have stopped in between', () => {
  const { journal, clock } = setup()
  journal.begin(entry)
  clock.now = new Date('2026-10-08T10:01:00.000Z')
  assert.equal(journal.settle(SUBMISSION)?.state, 'sending', 'a minute is not long enough')
  clock.now = new Date('2026-10-08T10:06:00.000Z')
  assert.equal(journal.settle(SUBMISSION)?.state, 'unknown')
  assert.equal(journal.get(SUBMISSION)?.state, 'unknown', 'and it stays that way')
})

test('settle leaves posted and young entries alone and knows nothing about an unknown id', () => {
  const { journal } = setup()
  assert.equal(journal.settle('nobody-0000000000001'), undefined)
  journal.begin(entry)
  assert.equal(journal.settle(SUBMISSION)?.state, 'sending')
  journal.markPosted(SUBMISSION, false)
  assert.equal(journal.settle(SUBMISSION)?.state, 'posted')
})

test('posted entries are forgotten after 30 days, unsure ones are not', () => {
  const { journal, clock } = setup()
  journal.begin(entry)
  journal.markPosted(SUBMISSION, true)
  const lost = 'lost-submission-00000001'
  journal.begin({ ...entry, submissionId: lost })
  journal.markUnknown(lost)
  clock.now = new Date('2026-12-01T10:00:00.000Z')
  journal.begin({ ...entry, submissionId: 'fresh-submission-0000001' })
  assert.deepEqual(journal.list().map((item) => item.submissionId).sort(), ['fresh-submission-0000001', lost].sort())
})

test('a posted entry is kept for 30 days: it still recognises a repeat after a few weeks', () => {
  const { journal, clock } = setup()
  journal.begin(entry)
  journal.markPosted(SUBMISSION, true)
  clock.now = new Date('2026-11-01T10:00:00.000Z')
  journal.begin({ ...entry, submissionId: 'another-submission-0000001' })
  assert.equal(journal.get(SUBMISSION)?.state, 'posted', '24 days later it is still known')
})

test('a damaged file is a clear error, not an empty journal', () => {
  const { journal, state } = setup()
  const odd = { submissionId: 'a-submission-000000001', requestId: 'doc-a-submission-000000001', state: 'weird', type: 'schouw', appointmentId: 'slot-1', by: 'acc', at: 'x', updatedAt: 'x' }
  for (const text of ['not json', '[]', '{"version":2,"documents":[]}', '{"version":1,"documents":[{"submissionId":"x"}]}', JSON.stringify({ version: 1, documents: [odd] }), JSON.stringify({ version: 1, documents: [{ ...odd, state: 'sending', type: 'offerte' }] })]) {
    state.text = text
    assert.throws(() => journal.list(), DocumentJournalFileError, text)
  }
  state.text = JSON.stringify({ version: 1, documents: [{ submissionId: 'a-submission-000000001', requestId: 'doc-a-submission-000000001', state: 'sending', type: 'schouw', appointmentId: 'slot-1', by: 'acc', at: 'x', updatedAt: 'x' }, { submissionId: 'a-submission-000000001', requestId: 'doc-a-submission-000000002', state: 'sending', type: 'schouw', appointmentId: 'slot-1', by: 'acc', at: 'x', updatedAt: 'x' }] })
  assert.throws(() => journal.list(), DocumentJournalFileError, 'the same submission twice')
})
