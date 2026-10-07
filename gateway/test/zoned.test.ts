import test from 'node:test'
import assert from 'node:assert/strict'
import { dayRangeInUtc, isTimeZone } from '../src/zoned.ts'

test('whole days in the Netherlands in summer time: midnight to one second before midnight, as Odoo UTC', () => {
  assert.deepEqual(dayRangeInUtc('2026-10-12', '2026-10-13', 'Europe/Amsterdam'), { dateFrom: '2026-10-11 22:00:00', dateTo: '2026-10-13 21:59:59' })
})

test('in winter time the offset is one hour', () => {
  assert.deepEqual(dayRangeInUtc('2026-12-01', '2026-12-01', 'Europe/Amsterdam'), { dateFrom: '2026-11-30 23:00:00', dateTo: '2026-12-01 22:59:59' })
})

test('the change of clocks is taken into account at each end separately', () => {
  // 25 October 2026: summer time ends (03:00 becomes 02:00).
  assert.deepEqual(dayRangeInUtc('2026-10-24', '2026-10-26', 'Europe/Amsterdam'), { dateFrom: '2026-10-23 22:00:00', dateTo: '2026-10-26 22:59:59' })
  // 29 March 2026: summer time starts (02:00 becomes 03:00).
  assert.deepEqual(dayRangeInUtc('2026-03-29', '2026-03-29', 'Europe/Amsterdam'), { dateFrom: '2026-03-28 23:00:00', dateTo: '2026-03-29 21:59:59' })
  assert.deepEqual(dayRangeInUtc('2026-03-28', '2026-03-30', 'Europe/Amsterdam'), { dateFrom: '2026-03-27 23:00:00', dateTo: '2026-03-30 21:59:59' })
})

test('other time zones, also with a half hour offset and none', () => {
  assert.deepEqual(dayRangeInUtc('2026-07-01', '2026-07-01', 'America/New_York'), { dateFrom: '2026-07-01 04:00:00', dateTo: '2026-07-02 03:59:59' })
  assert.deepEqual(dayRangeInUtc('2026-01-10', '2026-01-10', 'Asia/Kolkata'), { dateFrom: '2026-01-09 18:30:00', dateTo: '2026-01-10 18:29:59' })
  assert.deepEqual(dayRangeInUtc('2026-01-10', '2026-01-11', 'UTC'), { dateFrom: '2026-01-10 00:00:00', dateTo: '2026-01-11 23:59:59' })
})

test('a time zone Odoo or the system does not know, and odd dates, are refused instead of guessed', () => {
  for (const tz of ['', 'Nederland', 'Europe/Nergens', 'UTC+2', 5, null, undefined]) {
    assert.equal(isTimeZone(tz), false, String(tz))
    assert.throws(() => dayRangeInUtc('2026-10-12', '2026-10-12', tz as string))
  }
  assert.equal(isTimeZone('Europe/Amsterdam'), true)
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-10-13', '2026-10-12'], ['12-10-2026', '2026-10-13'], ['2026-10-12', ''], ['2026-10-12 00:00', '2026-10-13']]) {
    assert.throws(() => dayRangeInUtc(from, to, 'Europe/Amsterdam'), Error, `${from} - ${to}`)
  }
})

test('a zone that east of UTC changes its clocks during the day: the start is looked up at the real moment, not at the first guess', () => {
  // New Zealand: on Sunday 27 September 2026 the clocks go from 02:00 to 03:00 (12:00 UTC on the 26th is local midnight).
  assert.deepEqual(dayRangeInUtc('2026-09-27', '2026-09-27', 'Pacific/Auckland'), { dateFrom: '2026-09-26 12:00:00', dateTo: '2026-09-27 10:59:59' })
})
