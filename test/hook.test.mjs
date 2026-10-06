// The wiring: the hook, approve and status scripts run as Claude Code runs them, with a made-up usage reading.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// A reset three hours ahead, on the minute (keys are rounded to the minute), so the window is live.
const RESETS = new Date(Math.round((Date.now() + 3 * 3_600_000) / 60_000) * 60_000).toISOString()
const reading = (used, more = []) => JSON.stringify({ rows: [{ name: 'five_hour', used, resets: RESETS }, ...more] })

function run(script, { dir, fake, pluginRoot = '/plugins/usage-guard/1.0' }) {
  const r = spawnSync(process.execPath, [join(root, 'src', script)], {
    env: { ...process.env, USAGE_GUARD_DIR: dir, USAGE_GUARD_FAKE: fake, CLAUDE_PLUGIN_ROOT: pluginRoot },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr, json: script === 'hook.mjs' && r.stdout ? JSON.parse(r.stdout) : null }
}
const hook = (o) => run('hook.mjs', o)
const fresh = () => mkdtempSync(join(tmpdir(), 'usage-guard-'))
/** Ages the kept reading past the cache, as a minute passing would. */
function expire(dir) {
  const file = join(dir, 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  if (state.lastCheck) state.lastCheck.at -= 120_000
  writeFileSync(file, JSON.stringify(state))
}

test('below the thresholds the hook prints nothing and exits 0, and keeps the reading for a minute', () => {
  const dir = fresh()
  const r = hook({ dir, fake: reading(30) })
  assert.equal(r.code, 0)
  assert.equal(r.out, '')
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(state.lastCheck.usage.rows[0].used, 30)
  // Within the minute the kept reading is used, far from the limits.
  assert.equal(hook({ dir, fake: reading(91) }).out, '')
  expire(dir)
  assert.equal(hook({ dir, fake: reading(91) }).json.hookSpecificOutput.permissionDecision, 'deny')
})

test('at a stop the hook denies the call, and the message gives the approve line built from the plugin root', () => {
  const dir = fresh()
  const r = hook({ dir, fake: reading(91), pluginRoot: '/Users/someone/.claude/plugins/cache/claude-usage-guard/usage-guard/abc123' })
  assert.equal(r.code, 0)
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny')
  const line = '! node "/Users/someone/.claude/plugins/cache/claude-usage-guard/usage-guard/abc123/src/approve.mjs"'
  assert.ok(r.json.hookSpecificOutput.permissionDecisionReason.endsWith(line), r.json.hookSpecificOutput.permissionDecisionReason)
  assert.ok(r.json.systemMessage.endsWith(line), r.json.systemMessage)
})

test('approve.mjs, run by the person, lets the next call through; the next stop still holds', () => {
  const dir = fresh()
  assert.equal(hook({ dir, fake: reading(91) }).json.hookSpecificOutput.permissionDecision, 'deny')
  const a = run('approve.mjs', { dir, fake: reading(91) })
  assert.equal(a.code, 0)
  assert.match(a.out, /Approved: five_hour at 91%, past the 90% stop.*stops again at 95%/)
  // The first call after the approval goes ahead, with the one warning that names the next stop.
  const after = hook({ dir, fake: reading(92) })
  assert.equal(after.json.hookSpecificOutput.permissionDecision, undefined)
  assert.match(after.json.systemMessage, /stops at 95%/)
  assert.equal(hook({ dir, fake: reading(93) }).out, '')
  assert.equal(hook({ dir, fake: reading(95) }).json.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(run('approve.mjs', { dir, fake: reading(95) }).out, /past the 95% stop, until it resets \([^)]+\)\.\n$/)
  assert.equal(hook({ dir, fake: reading(99) }).out, '')
  assert.match(run('approve.mjs', { dir, fake: reading(99) }).out, /Nothing to approve/)
})

test('a warning reaches the person once and Claude as context, and the call goes ahead', () => {
  const dir = fresh()
  const r = hook({ dir, fake: reading(72) })
  assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined)
  assert.match(r.json.hookSpecificOutput.additionalContext, /Tell the person/)
  assert.match(r.json.systemMessage, /past 70%.*stops at 90%/)
  expire(dir)
  assert.equal(hook({ dir, fake: reading(73) }).out, '')
})

test('the thresholds come from config.json in the state folder; a broken one is reported once per call and ignored', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ warnAt: 50, stopAt: [60] }))
  assert.match(hook({ dir, fake: reading(50) }).json.systemMessage, /past 50%.*stops at 60%/)
  // From 50% (ten below the stop) every call reads afresh, so the stop is seen at once.
  assert.equal(hook({ dir, fake: reading(60) }).json.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(run('approve.mjs', { dir, fake: reading(60) }).out, /past the 60% stop, until it resets \([^)]+\)\.\n$/)
  assert.equal(hook({ dir, fake: reading(99) }).out, '')
  writeFileSync(join(dir, 'config.json'), '{ "stopAt": [95, 90] }')
  expire(dir)
  const r = hook({ dir, fake: reading(50) })
  assert.match(r.json.systemMessage, /config\.json ignored \(stopAt must be/)
  assert.equal(r.json.hookSpecificOutput, undefined)
})

test('when the usage cannot be read, the call goes ahead and the person is told', () => {
  const dir = fresh()
  const r = hook({ dir, fake: JSON.stringify({ error: 'plan limits are not available for this login' }) })
  assert.equal(r.code, 0)
  assert.equal(r.json.hookSpecificOutput, undefined)
  assert.match(r.json.systemMessage, /could not read your plan usage \(plan limits are not available/)
  assert.match(run('approve.mjs', { dir, fake: '{"error":"x"}' }).out, /nothing approved/)
})

test('the state file holds no entries for windows that have reset', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ warned: { 'five_hour@2020-01-01T00:00:00.000Z': true }, approved: { 'five_hour@2020-01-01T00:00:00.000Z': 90 } }))
  hook({ dir, fake: reading(30) })
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(state.warned, {})
  assert.deepEqual(state.approved, {})
})

test('status.mjs prints the reading, the thresholds and the approvals', () => {
  const dir = fresh()
  run('approve.mjs', { dir, fake: reading(91) })
  const s = JSON.parse(run('status.mjs', { dir, fake: reading(91) }).out)
  assert.equal(s.usage.rows[0].used, 91)
  assert.deepEqual(s.thresholds, { warnAt: 70, stopAt: [90, 95], paceAhead: 15 })
  assert.deepEqual(s.approved, { [`five_hour@${RESETS}`]: 90 })
  assert.equal(s.stateDir, dir)
})
