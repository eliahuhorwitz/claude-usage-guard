// The reader, with a sentinel token: it may appear in exactly one place, the Authorization header
// of the one request to the frozen endpoint, and nowhere in any result, message or file.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspect } from 'node:util'
import { USAGE_URL, accessTokenFrom, fetchUsage, parseUsage, readToken, readUsage, tokenHolder } from '../src/usage.mjs'

const ACCESS = 'SENTINEL-ACCESS-TOKEN-a1b2c3'
const REFRESH = 'SENTINEL-REFRESH-TOKEN-z9y8x7'
const blob = JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 1, scopes: ['user:inference'] }, organizationUuid: 'org' })
const RESETS = '2030-01-01T12:00:00.000Z'
const answer = {
  five_hour: { utilization: 42, resets_at: RESETS },
  seven_day: { utilization: 63.4, resets_at: '2030-01-05T12:00:00+00:00' },
  seven_day_opus: null,
  model_scoped: [{ display_name: 'Fable', utilization: 60, resets_at: RESETS }],
  extra_usage: { is_enabled: false },
}
const response = (status, body) => ({ status, json: async () => body })
const noLeak = (value, what) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) + inspect(value, { depth: 10 })
  assert.ok(!text.includes(ACCESS), `${what} leaks the access token: ${text.slice(0, 200)}`)
  assert.ok(!text.includes(REFRESH), `${what} leaks the refresh token: ${text.slice(0, 200)}`)
}

/** A fake world: a keychain, a home folder and a network that records every request. */
function world({ platform = 'darwin', keychain = blob, file, fetch } = {}) {
  const calls = []
  const home = mkdtempSync(join(tmpdir(), 'usage-guard-home-'))
  if (file !== undefined) {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), file)
  }
  const deps = {
    platform,
    home,
    execFile: (cmd, args, opts, cb) => {
      calls.push({ exec: [cmd, ...args] })
      setImmediate(() => (keychain === null ? cb(new Error('The specified item could not be found in the keychain.')) : cb(null, keychain)))
    },
    readFile: (p, enc) => readFileAsync(p, enc),
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (fetch) return fetch(url, init)
      return response(200, answer)
    },
  }
  return { deps, calls, home }
}
test('the token holder gives the token back only through use(); printing it shows nothing', () => {
  const h = tokenHolder(ACCESS)
  assert.equal(h.use(), ACCESS)
  assert.equal(String(h), '[redacted]')
  assert.equal(`${h}`, '[redacted]')
  assert.equal(JSON.stringify({ h }), '{"h":"[redacted]"}')
  noLeak(inspect(h), 'inspect')
  noLeak(inspect({ nested: { h } }, { depth: 5 }), 'nested inspect')
  assert.throws(() => { h.use = () => 'x' })
})

test('only the access token is taken out of a credentials blob; the refresh token is never kept', () => {
  const h = accessTokenFrom(blob)
  assert.equal(h.use(), ACCESS)
  assert.deepEqual(Object.keys(h), ['use', 'toString', 'toJSON'])
  assert.equal(accessTokenFrom(JSON.stringify({ claudeAiOauth: { refreshToken: REFRESH } })), null)
  assert.equal(accessTokenFrom(JSON.stringify({ claudeAiOauth: { accessToken: '' } })), null)
  assert.equal(accessTokenFrom('not json'), null)
  assert.equal(accessTokenFrom(''), null)
  assert.equal(accessTokenFrom(undefined), null)
  assert.equal(accessTokenFrom(ACCESS), null, 'a bare string is not a credentials blob')
})

test('on macOS the keychain is read by absolute path, with a timeout, and the file is the fallback', async () => {
  const w = world()
  const h = await readToken(w.deps)
  assert.equal(h.use(), ACCESS)
  assert.deepEqual(w.calls, [{ exec: ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'] }])
  const missing = world({ keychain: null, file: blob.replace(ACCESS, 'FILE-TOKEN') })
  assert.equal((await readToken(missing.deps)).use(), 'FILE-TOKEN')
  assert.equal(await readToken(world({ keychain: null }).deps), null)
})

test('elsewhere only the credentials file is read; the keychain is never asked', async () => {
  const w = world({ platform: 'linux', file: blob })
  assert.equal((await readToken(w.deps)).use(), ACCESS)
  assert.deepEqual(w.calls, [])
  assert.equal(await readToken(world({ platform: 'linux' }).deps), null)
})

test('the request goes to the frozen address only, with the token in the Authorization header and no redirects', async () => {
  process.env.USAGE_GUARD_URL = 'https://evil.example/usage'
  process.env.USAGE_URL = 'https://evil.example/usage'
  process.env.ANTHROPIC_BASE_URL = 'https://evil.example'
  try {
    const w = world()
    const r = await fetchUsage(tokenHolder(ACCESS), w.deps)
    assert.equal(w.calls.length, 1)
    const { url, init } = w.calls[0]
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(USAGE_URL, url)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `Bearer ${ACCESS}`)
    assert.match(init.headers['User-Agent'], /^claude-code\//)
    assert.ok(init.signal instanceof AbortSignal)
    noLeak(r, 'the result')
    assert.deepEqual(r, {
      rows: [
        { name: 'five_hour', used: 42, resets: RESETS },
        { name: 'seven_day', used: 63, resets: '2030-01-05T12:00:00.000Z' },
        { name: 'week_Fable', used: 60, resets: RESETS },
      ],
      extraUsage: false,
    })
  } finally {
    delete process.env.USAGE_GUARD_URL
    delete process.env.USAGE_URL
    delete process.env.ANTHROPIC_BASE_URL
  }
})

test('the answer goes through an allowlist: bad entries are dropped, unknown keys ignored, nothing else trusted', () => {
  assert.deepEqual(parseUsage({ five_hour: { utilization: 142, resets_at: RESETS }, nonsense: { utilization: 5, resets_at: RESETS } }), { rows: [{ name: 'five_hour', used: 100, resets: RESETS }], extraUsage: null })
  assert.deepEqual(parseUsage({ five_hour: { utilization: '42', resets_at: RESETS } }).rows, undefined)
  assert.match(parseUsage({ five_hour: { utilization: 42, resets_at: 'soon' } }).error, /no limits/)
  assert.match(parseUsage({ five_hour: { utilization: NaN, resets_at: RESETS } }).error, /no limits/)
  assert.match(parseUsage({ model_scoped: [{ display_name: '<script>', utilization: 1, resets_at: RESETS }] }).error, /no limits/)
  assert.match(parseUsage(null).error, /unexpected shape/)
  assert.match(parseUsage([]).error, /unexpected shape/)
  assert.match(parseUsage({}).error, /no limits/)
})

test('a failure answer gives only its status, never its body; a thrown error is scrubbed of the token', async () => {
  const h = tokenHolder(ACCESS)
  const r429 = await fetchUsage(h, world({ fetch: async () => response(429, { error: { message: `rate limited for ${ACCESS}` } }) }).deps)
  assert.deepEqual(r429, { error: 'the usage endpoint answered 429' })
  const r401 = await fetchUsage(h, world({ fetch: async () => response(401, {}) }).deps)
  assert.deepEqual(r401, { error: 'the usage endpoint answered 401' })
  const thrown = await fetchUsage(h, world({ fetch: async () => { throw new Error(`connect failed sending Bearer ${ACCESS} to host`) } }).deps)
  noLeak(thrown, 'a thrown error')
  assert.match(thrown.error, /could not reach the usage endpoint \(connect failed sending Bearer \[redacted\] to host\)/)
  const notJson = await fetchUsage(h, world({ fetch: async () => ({ status: 200, json: async () => { throw new SyntaxError(`Unexpected token ${ACCESS}`) } }) }).deps)
  noLeak(notJson, 'a JSON failure')
  assert.match(notJson.error, /not JSON/)
  const abort = await fetchUsage(h, world({ fetch: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e } }).deps)
  assert.match(abort.error, /timed out/)
})

test('end to end in a fake world: the token appears in exactly one place, the request header', async () => {
  const w = world()
  const r = await readUsage(w.deps)
  assert.equal(r.rows.length, 3)
  noLeak(r, 'the reading')
  const header = w.calls.filter((c) => c.init).map((c) => c.init.headers.Authorization)
  assert.deepEqual(header, [`Bearer ${ACCESS}`])
  noLeak(w.calls.map((c) => c.exec ?? c.url), 'the other call records')
  // Nothing was written anywhere in the fake home.
  assert.deepEqual(readdirSync(w.home), [])
})

test('without a login the reading says so, without throwing', async () => {
  const r = await readUsage(world({ keychain: null }).deps)
  assert.match(r.error, /no Claude login found/)
  const broken = { ...world().deps, execFile: () => { throw new Error('boom') }, readFile: async () => { throw new Error('nope') } }
  assert.match((await readUsage(broken)).error, /no Claude login found/)
})
