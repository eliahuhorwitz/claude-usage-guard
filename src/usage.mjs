// Reads the Claude plan's usage: the same numbers as /usage. No prompt is sent, so it costs nothing.
// It asks the usage endpoint Claude Code itself uses, with the login's access token. The endpoint is
// undocumented: if it ever changes, the guard says so instead of failing silently.
//
// The token is handled here and nowhere else. It is read from the keychain (macOS) or the
// credentials file, kept in a holder that prints as "[redacted]", sent only in the Authorization
// header to the one frozen address, never written to disk, and scrubbed from every error message.
// The refresh token beside it is never read.
import { execFile as execFileCb } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Frozen on purpose: no setting or environment variable can send the token anywhere else. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// The endpoint puts generic user agents in a tight rate-limit bucket (anthropics/claude-code#31637).
const USER_AGENT = 'claude-code/2.0.0 (usage-guard plugin)'
const BETA = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 10_000
const KEYCHAIN_TIMEOUT_MS = 3_000
const REDACTED = '[redacted]'

/** Where the state and config live: the person's home, so they survive plugin updates. */
export const stateDir = () => process.env.USAGE_GUARD_DIR || join(homedir(), '.claude', 'usage-guard')

const defaultDeps = () => ({
  platform: process.platform,
  home: homedir(),
  execFile: execFileCb,
  readFile: readFileAsync,
  fetch: (...a) => globalThis.fetch(...a),
})

/** Wraps the token so that printing, JSON and util.inspect never show it. Only use() gives it back. */
export function tokenHolder(raw) {
  return Object.freeze({
    use: () => raw,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    [Symbol.for('nodejs.util.inspect.custom')]: () => REDACTED,
  })
}

/** The access token out of a credentials blob (the keychain item or ~/.claude/.credentials.json). Nothing else is kept. */
export function accessTokenFrom(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const token = parsed?.claudeAiOauth?.accessToken
  return typeof token === 'string' && token.length > 0 ? tokenHolder(token) : null
}

function keychainText(deps) {
  return new Promise((resolve) => {
    try {
      // The absolute path: a `security` earlier on PATH must not be what runs.
      deps.execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf8', killSignal: 'SIGKILL' }, (err, stdout) => resolve(err ? null : stdout))
    } catch {
      resolve(null)
    }
  })
}

/** The login's access token, or null. macOS: the keychain, then the file; elsewhere: the file. */
export async function readToken(deps = defaultDeps()) {
  if (deps.platform === 'darwin') {
    const held = accessTokenFrom(await keychainText(deps))
    if (held) return held
  }
  try {
    return accessTokenFrom(await deps.readFile(join(deps.home, '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
const entry = (name, w) => {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null
  const ms = Date.parse(w.resets_at)
  if (typeof w.resets_at !== 'string' || Number.isNaN(ms)) return null
  return { name, used: Math.round(Math.min(100, Math.max(0, w.utilization))), resets: new Date(ms).toISOString() }
}

/** The names the limits list uses, and the row names the guard knows them by. */
const KINDS = { session: 'five_hour', weekly_all: 'seven_day', weekly_scoped: 'seven_day_model' }

/**
 * The endpoint's answer, taken through an allowlist: the limits list (kind, percent, reset), or, when
 * there is none, the known windows; sane numbers only, nothing else.
 */
export function parseUsage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the usage endpoint gave an answer of an unexpected shape' }
  const rows = []
  for (const l of Array.isArray(body.limits) ? body.limits : []) {
    if (!l || typeof l !== 'object' || typeof l.kind !== 'string' || !/^[a-z_]{1,40}$/.test(l.kind)) continue
    const e = entry(KINDS[l.kind] ?? l.kind, { utilization: l.percent, resets_at: l.resets_at })
    if (e) rows.push(e)
  }
  if (rows.length) return { rows, extraUsage: extraOf(body) }
  for (const name of WINDOWS) {
    const e = entry(name, body[name])
    if (e) rows.push(e)
  }
  for (const m of Array.isArray(body.model_scoped) ? body.model_scoped : []) {
    const e = m && typeof m.display_name === 'string' && /^[\w .-]{1,40}$/.test(m.display_name) ? entry(`week_${m.display_name}`, m) : null
    if (e) rows.push(e)
  }
  if (rows.length === 0) return { error: 'the usage endpoint listed no limits (an API-key login has none)' }
  return { rows, extraUsage: extraOf(body) }
}
const extraOf = (body) => (typeof body.extra_usage?.is_enabled === 'boolean' ? body.extra_usage.is_enabled : null)

/** The shape of a value: key names and types, never values. For telling what an endpoint change looks like. */
export function shapeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : []
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
  return typeof v
}

const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const isWindow = (w) => w && typeof w === 'object' && !Array.isArray(w) && typeof w.utilization === 'number' && typeof w.resets_at === 'string'
/** What the answer says about limits, in the open: every window's percentage and reset, the limits list, the weekly breakdown. No amounts of money. */
export function detailOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o && scalar(o[k])).map((k) => [k, o[k]]))
  return {
    windows: Object.entries(body).filter(([, w]) => isWindow(w)).map(([key, w]) => ({ key, ...pick(w, ['utilization', 'resets_at', 'locked_reason']) })),
    limits: (Array.isArray(body.limits) ? body.limits : []).filter((l) => l && typeof l === 'object').map((l) => pick(l, ['kind', 'group', 'percent', 'severity', 'resets_at', 'scope', 'is_active'])),
    breakdown: (Array.isArray(body.seven_day_breakdown?.rows) ? body.seven_day_breakdown.rows : []).filter((r) => r && typeof r === 'object').map((r) => pick(r, ['key', 'display_name', 'percent'])),
  }
}

/**
 * Asks the endpoint. The token leaves this process in exactly one place: the Authorization header of this request.
 * With `shape`, the answer's shape (keys and types only) and its detail (see detailOf) are returned beside the reading.
 */
export async function fetchUsage(held, deps = defaultDeps(), { shape = false } = {}) {
  const scrub = (s) => String(s).split(held.use()).join(REDACTED)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await deps.fetch(USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${held.use()}`, 'anthropic-beta': BETA, 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      // A redirect must never carry the Authorization header anywhere, not even to the same host.
      redirect: 'error',
    })
    if (!res || typeof res.status !== 'number') return { error: 'no answer from the usage endpoint' }
    // The body of a failure is not repeated: it is not ours to show.
    if (res.status !== 200) return { error: `the usage endpoint answered ${res.status}` }
    let body
    try {
      body = await res.json()
    } catch {
      return { error: 'the usage endpoint gave an answer that is not JSON' }
    }
    const parsed = parseUsage(body)
    return shape ? { ...parsed, shape: shapeOf(body), detail: detailOf(body) } : parsed
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timed out' : scrub(err?.message ?? err).split('\n')[0]
    return { error: `could not reach the usage endpoint (${msg})` }
  } finally {
    clearTimeout(timer)
  }
}

/** The plan's usage: { rows: [{ name, used, resets }], extraUsage } or { error }. Never throws, never leaks. */
export async function readUsage(deps = defaultDeps(), options = {}) {
  // For testing the wiring only: a made-up reading.
  if (process.env.USAGE_GUARD_FAKE) return JSON.parse(process.env.USAGE_GUARD_FAKE)
  let held
  try {
    held = await readToken(deps)
  } catch {
    held = null
  }
  if (!held) return { error: 'no Claude login found (not signed in to Claude Code, or signed in with an API key)' }
  try {
    return await fetchUsage(held, deps, options)
  } catch (err) {
    return { error: String(err?.message ?? err).split(held.use()).join(REDACTED).split('\n')[0] }
  }
}

export function loadState(dir = stateDir()) {
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  } catch {
    return { warned: {}, approved: {} }
  }
}

export function saveState(state, dir = stateDir()) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  const tmp = `${file}.${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file)
}
