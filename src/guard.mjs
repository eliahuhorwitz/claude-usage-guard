// The decision, kept free of I/O so it can be tested: given the plan's usage, what was already
// approved and warned about, and the thresholds, should a tool call go ahead?
import { DEFAULTS } from './config.mjs'

const WEEK_MS = 7 * 86_400_000
/** This many points below the first stop, a reading up to a minute old is good enough; from there on, every call is checked. */
export const CLOSE_BELOW_STOP = 10
export const CACHE_MS = 60_000
/** How often to repeat "the usage could not be read". */
export const ERROR_REPEAT_MS = 10 * 60_000

const NAMES = { five_hour: '5-hour window', seven_day: 'weekly limit', seven_day_opus: 'weekly Opus limit', seven_day_sonnet: 'weekly Sonnet limit' }
const nameOf = (w) => NAMES[w] ?? w.replace(/^week_/, 'weekly ').replace(/_/g, ' ')
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : 'unknown')

/**
 * A window is identified by its name and when it resets, so approvals and warnings end with it.
 * The reset time is rounded to the minute: each reading reports it with up to a second of jitter.
 */
export function windowKey(row) {
  const ms = Date.parse(row.resets)
  const resets = Number.isNaN(ms) ? String(row.resets) : new Date(Math.round(ms / 60_000) * 60_000).toISOString()
  return `${row.name}@${resets}`
}

const weekly = (r) => r.name.startsWith('seven_day') || r.name.startsWith('week_')
/** How much of a weekly window has passed, in percent. */
const weekGone = (r, now) => Math.round(Math.min(1, Math.max(0, 1 - (Date.parse(r.resets) - now) / WEEK_MS)) * 100)

/** Whether a fresh reading is needed. */
export function needsCheck(state, now, config = DEFAULTS) {
  const last = state.lastCheck
  if (!last || !last.usage || last.usage.error) return true
  const worst = Math.max(0, ...last.usage.rows.map((r) => r.used))
  return worst >= config.stopAt[0] - CLOSE_BELOW_STOP || now - last.at >= CACHE_MS
}

/** The highest stop level a window has reached, or 0. */
export const stopLevel = (used, stopAt = DEFAULTS.stopAt) => stopAt.filter((l) => used >= l).at(-1) ?? 0

/**
 * @param usage { rows: [{ name, used, resets }] } or { error }
 * @param state { warned: { [key]: true }, approved: { [key]: level }, lastError?: number }
 * @param now milliseconds
 * @param options { config?: thresholds (see config.mjs), approveCommand?: what the person runs to continue }
 * @returns { allow, reason?, message?, state } — reason goes to Claude, message to the person
 */
export function decide(usage, state, now, options = {}) {
  const { warnAt, stopAt, paceAhead } = options.config ?? DEFAULTS
  const approveCommand = options.approveCommand ?? 'the approve command'
  const next = { warned: { ...(state.warned ?? {}) }, approved: { ...(state.approved ?? {}) }, lastError: state.lastError }
  if (usage.error) {
    // Failing closed would stop every session whenever the experimental usage API changes; fail open, loudly.
    const say = !state.lastError || now - state.lastError >= ERROR_REPEAT_MS
    if (say) next.lastError = now
    return { allow: true, message: say ? `Usage guard could not read your plan usage (${usage.error}). Continuing without it.` : undefined, state: next }
  }
  const level = (r) => stopLevel(r.used, stopAt)
  const blocked = usage.rows.filter((r) => level(r) > (next.approved[windowKey(r)] ?? 0))
  if (blocked.length) {
    const lines = blocked.map((r) => `${nameOf(r.name)} at ${r.used}% (resets ${when(r.resets)})`).join('; ')
    const top = Math.max(...blocked.map(level))
    return {
      allow: false,
      reason: `Usage guard: stopped at ${top}% of the Claude plan (${lines}). Do not try to work around this, and never run the approve command yourself. Tell the person, and wait: only they can approve, by running  ${approveCommand}`,
      message: `Usage guard: Claude Code is paused at ${top}% (${lines}). To continue, run:  ${approveCommand}`,
      state: next,
    }
  }
  const ahead = (r) => weekly(r) && r.resets && r.used - weekGone(r, now) > paceAhead
  const warn = usage.rows.filter((r) => (r.used >= warnAt || ahead(r)) && !next.warned[windowKey(r)])
  for (const r of warn) next.warned[windowKey(r)] = true
  if (warn.length) {
    const pace = (r) => (weekly(r) && r.resets ? ` with ${weekGone(r, now)}% of the week gone` : '')
    const lines = warn.map((r) => `${nameOf(r.name)} at ${r.used}%${pace(r)} (resets ${when(r.resets)})`).join('; ')
    const nextStop = Math.min(...warn.map((r) => stopAt.find((l) => l > (next.approved[windowKey(r)] ?? 0)) ?? 100))
    return {
      allow: true,
      reason: `Usage guard: high Claude plan usage (${lines}). Tell the person.`,
      message: `Usage guard: ${warn.some((r) => r.used >= warnAt) ? `past ${warnAt}%` : 'ahead of pace'}: ${lines}. Work stops at ${nextStop}%.`,
      state: next,
    }
  }
  return { allow: true, state: next }
}

/** Approve every window that is currently stopped, up to the level it has reached, until it resets. */
export function approve(usage, state, config = DEFAULTS) {
  const approved = { ...(state.approved ?? {}) }
  const done = []
  for (const r of usage.rows ?? []) {
    const level = stopLevel(r.used, config.stopAt)
    if (level > (approved[windowKey(r)] ?? 0)) {
      approved[windowKey(r)] = level
      done.push({ ...r, level })
    }
  }
  return { state: { ...state, approved }, done }
}

/** Drops warnings and approvals of windows that have reset, so the state file does not grow forever. */
export function prune(state, now) {
  const live = (key) => {
    const ms = Date.parse(key.slice(key.indexOf('@') + 1))
    return Number.isNaN(ms) || ms > now
  }
  const keep = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => live(k)))
  return { ...state, warned: keep(state.warned), approved: keep(state.approved) }
}
