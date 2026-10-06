import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECORDS, PAGE_SIZE, readAllPages } from '../src/lib/paging.ts'

type Row = { id: number }

/** A source with `total` records (ids 1..total) that remembers every read. */
function source(total: number, rows: Row[] = Array.from({ length: total }, (_, index) => ({ id: index + 1 }))) {
  const reads: Array<[number, number]> = []
  const readPage = async (offset: number, limit: number) => {
    reads.push([offset, limit])
    return rows.slice(offset, offset + limit)
  }
  return { readPage, reads }
}

test('the defaults: pages of 500 (the limit of the gateway project), at most 5000 records', () => {
  assert.equal(PAGE_SIZE, 500)
  assert.equal(MAX_RECORDS, 5000)
})

test('nothing to read gives an empty, complete result', async () => {
  const { readPage, reads } = source(0)
  assert.deepEqual(await readAllPages(readPage), { records: [], truncated: false })
  assert.deepEqual(reads, [[0, 500]])
})

test('fewer records than a page need one read', async () => {
  const { readPage, reads } = source(120)
  const result = await readAllPages(readPage)
  assert.equal(result.records.length, 120)
  assert.equal(result.truncated, false)
  assert.deepEqual(reads, [[0, 500]])
})

test('more records than a page are read page after page, in order, until a page is not full', async () => {
  const { readPage, reads } = source(1200)
  const result = await readAllPages(readPage)
  assert.deepEqual(result.records.map((row) => row.id), Array.from({ length: 1200 }, (_, index) => index + 1))
  assert.equal(result.truncated, false)
  assert.deepEqual(reads, [[0, 500], [500, 500], [1000, 500]])
})

test('an exact multiple of the page size needs one more (empty) read to be sure it is complete', async () => {
  const { readPage, reads } = source(1000)
  const result = await readAllPages(readPage)
  assert.equal(result.records.length, 1000)
  assert.equal(result.truncated, false)
  assert.deepEqual(reads, [[0, 500], [500, 500], [1000, 500]])
})

test('a record that shows up on two pages (the data moved while reading) is kept once', async () => {
  const rows: Row[] = Array.from({ length: 700 }, (_, index) => ({ id: index + 1 }))
  rows[500] = { id: 3 } // the second page starts with a record the first page already had
  const { readPage } = source(0, rows)
  const result = await readAllPages(readPage)
  assert.equal(result.records.length, 699)
  assert.equal(new Set(result.records.map((row) => row.id)).size, 699)
})

test('at the maximum it stops and says so when there is more', async () => {
  const { readPage, reads } = source(5000)
  const result = await readAllPages(readPage, { pageSize: 500, maxRecords: 1000 })
  assert.equal(result.records.length, 1000)
  assert.equal(result.truncated, true)
  // two full pages, then one record to find out whether anything is left
  assert.deepEqual(reads, [[0, 500], [500, 500], [1000, 1]])
})

test('exactly the maximum is complete, not truncated', async () => {
  const { readPage, reads } = source(1000)
  const result = await readAllPages(readPage, { pageSize: 500, maxRecords: 1000 })
  assert.equal(result.records.length, 1000)
  assert.equal(result.truncated, false)
  assert.deepEqual(reads, [[0, 500], [500, 500], [1000, 1]])
})

test('a maximum that is not a multiple of the page size is never exceeded', async () => {
  const { readPage, reads } = source(2000)
  const result = await readAllPages(readPage, { pageSize: 500, maxRecords: 750 })
  assert.equal(result.records.length, 750)
  assert.equal(result.truncated, true)
  assert.deepEqual(reads, [[0, 500], [500, 250], [750, 1]])
})

test('a failing page fails the whole read: no half result that looks complete', async () => {
  let calls = 0
  const readPage = async (offset: number, limit: number) => {
    calls += 1
    if (calls === 2) throw new Error('Odoo-gateway is niet bereikbaar.')
    return Array.from({ length: limit }, (_, index) => ({ id: offset + index + 1 }))
  }
  await assert.rejects(readAllPages(readPage), { message: 'Odoo-gateway is niet bereikbaar.' })
  assert.equal(calls, 2)
})

test('a source that returns more than asked for does not loop forever, and nothing is read twice', async () => {
  const reads: Array<[number, number]> = []
  const readPage = async (offset: number, limit: number) => {
    reads.push([offset, limit])
    return Array.from({ length: 800 }, (_, index) => ({ id: offset + index + 1 }))
  }
  const result = await readAllPages(readPage, { pageSize: 500, maxRecords: 1000 })
  assert.equal(result.records.length, 1600)
  assert.equal(result.truncated, true)
  // the next read starts after what was received, not after what was asked
  assert.deepEqual(reads, [[0, 500], [800, 200], [1600, 1]])
})
