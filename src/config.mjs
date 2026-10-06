// The guard's thresholds, in percent of the plan. Defaults, overridden by ~/.claude/usage-guard/config.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = Object.freeze({
  /** Warn once per window from here on. */
  warnAt: 70,
  /** Pause every tool call at each of these, until the person approves; ascending. */
  stopAt: [90, 95],
  /** Weekly limits also warn when usage is this many points ahead of the share of the week that has passed. */
  paceAhead: 15,
})

const percent = (v) => Number.isInteger(v) && v >= 1 && v <= 100

/** Checks a config object; returns the valid config, or a problem (and the defaults). */
export function parseConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { config: DEFAULTS, problem: 'not an object' }
  const config = { ...DEFAULTS }
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) return { config: DEFAULTS, problem: `unknown key "${key}"` }
  }
  if ('warnAt' in raw) {
    if (!percent(raw.warnAt)) return { config: DEFAULTS, problem: 'warnAt must be a whole number from 1 to 100' }
    config.warnAt = raw.warnAt
  }
  if ('paceAhead' in raw) {
    if (!percent(raw.paceAhead)) return { config: DEFAULTS, problem: 'paceAhead must be a whole number from 1 to 100' }
    config.paceAhead = raw.paceAhead
  }
  if ('stopAt' in raw) {
    const s = raw.stopAt
    const ok = Array.isArray(s) && s.length > 0 && s.every(percent) && s.every((v, i) => i === 0 || v > s[i - 1])
    if (!ok) return { config: DEFAULTS, problem: 'stopAt must be a non-empty ascending list of whole numbers from 1 to 100' }
    config.stopAt = [...s]
  }
  if (config.warnAt > config.stopAt[0]) return { config: DEFAULTS, problem: 'warnAt must not be above the first stop' }
  return { config }
}

/** Reads <dir>/config.json. No file means the defaults; a bad file means the defaults and a problem to report. */
export function readConfig(dir) {
  let text
  try {
    text = readFileSync(join(dir, 'config.json'), 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { config: DEFAULTS }
    return { config: DEFAULTS, problem: `cannot read config.json (${err?.message ?? err})` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: DEFAULTS, problem: 'config.json is not valid JSON' }
  }
  return parseConfig(raw)
}
