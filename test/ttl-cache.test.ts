import test from 'node:test'
import assert from 'node:assert/strict'
import { withCache } from '../src/lib/ttl-cache.ts'

function counter(values: Array<number | Error>) {
  let calls = 0
  const load = async () => {
    const next = values[calls++]
    if (next instanceof Error) throw next
    return next
  }
  return { load, calls: () => calls }
}

test('caches within the ttl and reloads after it', async () => {
  let now = 0
  const c = counter([1, 2])
  const read = withCache('k', 10, c.load, () => now)
  assert.equal(await read(), 1)
  now = 9_999
  assert.equal(await read(), 1)
  assert.equal(c.calls(), 1)
  now = 10_001
  assert.equal(await read(), 2)
})

test('refresh forces a new read', async () => {
  const c = counter([1, 2, 3])
  const read = withCache('k', 300, c.load)
  assert.equal(await read(), 1)
  assert.equal(await read.refresh(), 2)
  assert.equal(await read(), 2)
})

test('concurrent callers share one read', async () => {
  const c = counter([1, 2])
  const read = withCache('k', 300, c.load)
  assert.deepEqual(await Promise.all([read(), read(), read()]), [1, 1, 1])
  assert.equal(c.calls(), 1)
})

test('failures are not cached and the next call retries', async () => {
  const c = counter([new Error('odoo down'), 5])
  const read = withCache('k', 300, c.load)
  await assert.rejects(read(), /odoo down/)
  assert.equal(await read(), 5)
  assert.equal(c.calls(), 2)
})

test('a failed refresh does not keep serving the stale value', async () => {
  const c = counter([1, new Error('odoo down'), 3])
  const read = withCache('k', 300, c.load)
  await read()
  await assert.rejects(read.refresh(), /odoo down/)
  assert.equal(await read(), 3)
})
