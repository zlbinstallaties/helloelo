import test from 'node:test'
import assert from 'node:assert/strict'
import { newRequestId } from '../src/lib/request-id.ts'

const VALID = /^[A-Za-z0-9_-]{16,64}$/

test('a request id has the shape the server accepts, with randomUUID', () => {
  const id = newRequestId({ randomUUID: () => '123e4567-e89b-12d3-a456-426614174000', getRandomValues: () => { throw new Error('unused') } })
  assert.equal(id, '123e4567-e89b-12d3-a456-426614174000')
  assert.match(id, VALID)
})

test('without randomUUID (a page that is not https) random bytes are used, and the id is still valid', () => {
  const id = newRequestId({ getRandomValues: (bytes) => { bytes.fill(171); return bytes } })
  assert.match(id, VALID)
  assert.equal(id.length, 32)
})

test('ids are different every time', () => {
  const seen = new Set(Array.from({ length: 200 }, () => newRequestId()))
  assert.equal(seen.size, 200)
  for (const id of seen) assert.match(id, VALID)
})

test('a crypto that does nothing useful is an error, never a fixed id', () => {
  assert.throws(() => newRequestId({}), /random/)
})
