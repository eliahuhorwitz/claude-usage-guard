// Reads the Claude plan's usage (the same numbers as /usage; no prompt is sent, so it costs nothing)
// and keeps the guard's state. The usage comes from an experimental Agent SDK call: if that ever
// breaks, the guard says so instead of failing silently.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the state and config live: the person's home, so they survive plugin updates. */
export const stateDir = () => process.env.USAGE_GUARD_DIR || join(homedir(), '.claude', 'usage-guard')

export async function readUsage() {
  // For testing the wiring only: a made-up reading.
  if (process.env.USAGE_GUARD_FAKE) return JSON.parse(process.env.USAGE_GUARD_FAKE)
  let query
  try {
    ;({ query } = await import('@anthropic-ai/claude-agent-sdk'))
  } catch {
    return { error: 'the Agent SDK is not installed; run  npm ci  in the plugin folder' }
  }
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  let stop
  const idle = (async function* () {
    await new Promise((r) => (stop = r))
  })()
  // No settings are loaded, so this inner session runs no hooks of its own (and cannot loop into this one).
  const q = query({ prompt: idle, options: { env, settingSources: [], tools: [] } })
  try {
    const timeout = new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 30_000).unref())
    const u = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timeout])
    if (!u.rate_limits_available || !u.rate_limits) return { error: 'plan limits are not available for this login' }
    const r = u.rate_limits
    const windows = { five_hour: r.five_hour, seven_day: r.seven_day, seven_day_opus: r.seven_day_opus, seven_day_sonnet: r.seven_day_sonnet }
    for (const m of r.model_scoped ?? []) windows[`week_${m.display_name}`] = m
    const rows = Object.entries(windows)
      .filter(([, w]) => w && typeof w.utilization === 'number')
      .map(([name, w]) => ({ name, used: w.utilization, resets: w.resets_at }))
    return { rows, extraUsage: r.extra_usage?.is_enabled ?? null }
  } catch (err) {
    return { error: String(err?.message ?? err).split('\n')[0] }
  } finally {
    stop?.()
    q.close?.()
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
