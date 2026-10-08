import test from 'node:test'
import assert from 'node:assert/strict'
import { containerIdFromCgroup, parseConfigFlag, withBlock, withoutBlock } from '../install/caddy.ts'
import { CADDY_BEGIN, CADDY_END } from '../install/templates.ts'

const BLOCK = `${CADDY_BEGIN}\nexample.org {\n\treverse_proxy 127.0.0.1:1\n}\n${CADDY_END}\n`

test('withBlock adds the block at the end, and withoutBlock gives the original file back exactly', () => {
  const files = [
    '{\n    admin off\n}\nodoo.example {\n    reverse_proxy 127.0.0.1:18069\n}\n',
    'site.example {\n    respond "hi"\n}\n\n\n',
    '',
    '# only a comment\n',
  ]
  for (const original of files) {
    const added = withBlock(original, BLOCK)
    assert.ok(added.startsWith(original), `nothing before the block changed: ${JSON.stringify(original)}`)
    assert.ok(added.endsWith(BLOCK))
    assert.equal(withoutBlock(added), original, JSON.stringify(original))
  }
  // A file that does not end in a newline gets one (the only change the round trip makes).
  assert.equal(withoutBlock(withBlock('a {\n}', BLOCK)), 'a {\n}\n')
})

test('adding a block twice replaces the first one instead of stacking', () => {
  const once = withBlock('a.example {\n}\n', BLOCK)
  const changed = BLOCK.replace('127.0.0.1:1', '127.0.0.1:2')
  const twice = withBlock(once, changed)
  assert.equal([...twice.matchAll(/# BEGIN DIG Builder/g)].length, 1)
  assert.ok(twice.includes('127.0.0.1:2') && !twice.includes('127.0.0.1:1\n'))
  assert.equal(withBlock(twice, changed), twice, 'the same block again changes nothing')
  assert.equal(withoutBlock(twice), 'a.example {\n}\n')
})

test('a half block (no END line) is left alone rather than cutting into the file', () => {
  const broken = `a.example {\n}\n\n${CADDY_BEGIN}\nlost {\n}\n`
  assert.equal(withoutBlock(broken), broken)
})

test('the config path is read from the Caddy command line, with the usual default', () => {
  assert.equal(parseConfigFlag('caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'), '/etc/caddy/Caddyfile')
  assert.equal(parseConfigFlag('/usr/bin/caddy run --config=/opt/odoo20-test/Caddyfile'), '/opt/odoo20-test/Caddyfile')
  assert.equal(parseConfigFlag('caddy run'), '/etc/caddy/Caddyfile')
})

test('the container behind a Caddy process is found in both cgroup layouts', () => {
  const id = 'cddde94abb21ec1faa4f852f5bf647896d53ce6ec33d02eff71054261c75ccba'
  assert.equal(containerIdFromCgroup(`0::/system.slice/docker-${id}.scope\n`), id)
  assert.equal(containerIdFromCgroup(`12:cpu:/docker/${id}\n`), id)
  assert.equal(containerIdFromCgroup('0::/system.slice/caddy.service\n'), null)
  assert.equal(containerIdFromCgroup(''), null)
})
