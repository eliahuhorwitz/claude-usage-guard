// Claude Code PreToolUse hook: runs before every tool call, in every session.
import { readConfig } from './config.mjs'
import { decide, needsCheck, prune } from './guard.mjs'
import { approveCommand } from './paths.mjs'
import { loadState, readUsage, saveState, stateDir } from './usage.mjs'

const out = {}
try {
  const now = Date.now()
  const dir = stateDir()
  const { config, problem } = readConfig(dir)
  const state = loadState(dir)
  let usage
  if (needsCheck(state, now, config)) {
    usage = await readUsage()
    state.lastCheck = { at: now, usage }
  } else usage = state.lastCheck.usage

  const d = decide(usage, state, now, { config, approveCommand: approveCommand() })
  saveState(prune({ ...d.state, lastCheck: state.lastCheck }, now), dir)

  const notes = []
  if (problem) notes.push(`Usage guard: config.json ignored (${problem}); using the defaults.`)
  if (d.message) notes.push(d.message)
  if (notes.length) out.systemMessage = notes.join(' ')
  if (!d.allow) out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason }
  else if (d.reason) out.hookSpecificOutput = { hookEventName: 'PreToolUse', additionalContext: d.reason }
} catch (err) {
  // Never let a bug in the guard stop the session: fail open, and say so.
  out.systemMessage = `Usage guard failed (${String(err?.message ?? err).split('\n')[0]}). Continuing without it.`
}
if (Object.keys(out).length) process.stdout.write(JSON.stringify(out))
process.exit(0)
