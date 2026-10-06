import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approve, decide, needsCheck, prune, windowKey } from '../src/guard.mjs'

const T = 1_000_000
const row = (used, name = 'five_hour', resets = '2026-10-02T20:50:00Z') => ({ name, used, resets })
const usage = (...rows) => ({ rows })
const fresh = { warned: {}, approved: {} }
const APPROVE = '! node "/plugins/usage-guard/src/approve.mjs"'
const opts = { approveCommand: APPROVE }

test('below 70% nothing is said and nothing is stopped', () => {
  const d = decide(usage(row(69), row(10, 'seven_day')), fresh, T, opts)
  assert.equal(d.allow, true)
  assert.equal(d.message, undefined)
  assert.equal(d.reason, undefined)
})

test('at 70% it warns once per window, telling both the person and Claude', () => {
  const first = decide(usage(row(70)), fresh, T, opts)
  assert.equal(first.allow, true)
  assert.match(first.message, /70%/)
  assert.match(first.reason, /Tell the person/)
  const again = decide(usage(row(75)), first.state, T + 1, opts)
  assert.equal(again.message, undefined)
  // A new window (after a reset) gets its own warning.
  const nextWindow = decide(usage(row(71, 'five_hour', '2026-10-03T01:50:00Z')), again.state, T + 2, opts)
  assert.match(nextWindow.message, /70%/)
})

test('at 90% every tool call is refused until approved, and both messages say only the person can approve, with the command', () => {
  const d = decide(usage(row(90)), fresh, T, opts)
  assert.equal(d.allow, false)
  assert.match(d.reason, /never run the approve command yourself/)
  assert.ok(d.reason.endsWith(APPROVE), d.reason)
  assert.ok(d.message.endsWith(APPROVE), d.message)
  assert.equal(decide(usage(row(95)), d.state, T + 1, opts).allow, false)
})

test('the weekly limit stops work just like the 5-hour window, and the message names it', () => {
  const d = decide(usage(row(20), row(91, 'seven_day', '2026-10-08T10:00:00Z')), fresh, T, opts)
  assert.equal(d.allow, false)
  assert.match(d.message, /weekly limit at 91%/)
  const model = decide(usage(row(20), row(90, 'seven_day_model', '2026-10-08T10:00:00Z')), fresh, T, opts)
  assert.equal(model.allow, false)
  assert.match(model.message, /weekly model limit at 90%/)
  assert.match(decide(usage(row(91, 'weekly_oauth_apps')), fresh, T, opts).message, /weekly oauth apps at 91%/)
})

test('approving at 90% lets work continue, but 95% stops it again', () => {
  const { state, done } = approve(usage(row(92)), fresh)
  assert.deepEqual(done.map((r) => r.level), [90])
  assert.equal(decide(usage(row(92)), state, T, opts).allow, true)
  assert.equal(decide(usage(row(94)), state, T, opts).allow, true)
  const at95 = decide(usage(row(95)), state, T, opts)
  assert.equal(at95.allow, false)
  assert.match(at95.message, /95%/)
  const again = approve(usage(row(95)), state)
  assert.equal(decide(usage(row(99)), again.state, T, opts).allow, true)
})

test('an approval ends when its window resets', () => {
  const { state } = approve(usage(row(92)), fresh)
  assert.equal(decide(usage(row(92, 'five_hour', '2026-10-03T01:50:00Z')), state, T, opts).allow, false)
})

test('approving one window does not approve another', () => {
  const { state } = approve(usage(row(92), row(50, 'seven_day')), fresh)
  assert.equal(decide(usage(row(92), row(90, 'seven_day')), state, T, opts).allow, false)
})

test('approval cannot be given in advance: below 90% there is nothing to approve', () => {
  const { state, done } = approve(usage(row(89)), fresh)
  assert.deepEqual(done, [])
  assert.equal(decide(usage(row(90)), state, T, opts).allow, false)
})

test('if the usage cannot be read it lets work go on, but says so, at most every ten minutes', () => {
  const d = decide({ error: 'boom' }, fresh, T, opts)
  assert.equal(d.allow, true)
  assert.match(d.message, /could not read/)
  assert.equal(decide({ error: 'boom' }, d.state, T + 60_000, opts).message, undefined)
  assert.match(decide({ error: 'boom' }, d.state, T + 11 * 60_000, opts).message, /could not read/)
})

test('far from the limits a minute-old reading is reused; from 80% on, every call is checked', () => {
  const at = (used, ago) => ({ lastCheck: { at: T - ago, usage: usage(row(used)) } })
  assert.equal(needsCheck({}, T), true)
  assert.equal(needsCheck(at(50, 30_000), T), false)
  assert.equal(needsCheck(at(50, 61_000), T), true)
  assert.equal(needsCheck(at(80, 1_000), T), true)
  assert.equal(needsCheck({ lastCheck: { at: T, usage: { error: 'x' } } }, T), true)
  // "Close" follows the first stop: with a stop at 60, every call is checked from 50%.
  const low = { warnAt: 40, stopAt: [60], paceAhead: 15 }
  assert.equal(needsCheck(at(49, 1_000), T, low), false)
  assert.equal(needsCheck(at(50, 1_000), T, low), true)
})

test('a warning names the next stop that still applies', () => {
  assert.match(decide(usage(row(72)), fresh, T, opts).message, /stops at 90%/)
  const { state } = approve(usage(row(91)), fresh)
  const d = decide(usage(row(93)), state, T, opts)
  assert.equal(d.allow, true)
  assert.match(d.message, /stops at 95%/)
  assert.doesNotMatch(d.message, /90%/)
})

// The reset time comes back with up to a second of jitter from one reading to the next.
test('a window keeps its identity across the jitter in its reset time', () => {
  assert.equal(windowKey(row(1, 'five_hour', '2026-10-02T20:49:59.541362+00:00')), windowKey(row(1, 'five_hour', '2026-10-02T20:50:00.490701+00:00')))
  assert.notEqual(windowKey(row(1, 'five_hour', '2026-10-02T20:50:00Z')), windowKey(row(1, 'five_hour', '2026-10-02T20:51:00Z')))
  assert.notEqual(windowKey(row(1, 'five_hour', '2026-10-02T20:50:00Z')), windowKey(row(1, 'seven_day', '2026-10-02T20:50:00Z')))
  // An unreadable reset time is still a key, not a crash.
  assert.equal(windowKey({ name: 'x', resets: undefined }), 'x@undefined')
})

test('the jitter neither repeats a warning nor undoes an approval', () => {
  const a = row(72, 'five_hour', '2026-10-02T20:49:59.541362+00:00')
  const b = row(73, 'five_hour', '2026-10-02T20:50:00.490701+00:00')
  const warned = decide(usage(a), fresh, T, opts)
  assert.match(warned.message, /72%/)
  assert.equal(decide(usage(b), warned.state, T + 1, opts).message, undefined)
  const { state } = approve(usage({ ...a, used: 91 }), fresh)
  assert.equal(decide(usage({ ...b, used: 92 }), state, T, opts).allow, true)
})

test('warnings and approvals of windows that have reset are pruned', () => {
  const now = Date.parse('2026-10-03T00:00:00Z')
  const state = {
    warned: { 'five_hour@2026-10-02T20:50:00.000Z': true, 'seven_day@2026-10-09T21:00:00.000Z': true },
    approved: { 'five_hour@2026-10-02T20:50:00.000Z': 90, 'five_hour@2026-10-03T01:50:00.000Z': 90, 'x@undefined': 90 },
    lastError: 5,
  }
  assert.deepEqual(prune(state, now), {
    warned: { 'seven_day@2026-10-09T21:00:00.000Z': true },
    approved: { 'five_hour@2026-10-03T01:50:00.000Z': 90, 'x@undefined': 90 },
    lastError: 5,
  })
  assert.deepEqual(prune({}, now), { warned: {}, approved: {} })
})

test('the thresholds come from the config: warn, stop and approve follow it', () => {
  const config = { warnAt: 50, stopAt: [60, 80, 99], paceAhead: 15 }
  const o = { ...opts, config }
  assert.equal(decide(usage(row(49)), fresh, T, o).message, undefined)
  assert.match(decide(usage(row(50)), fresh, T, o).message, /past 50%.*stops at 60%/)
  assert.equal(decide(usage(row(59)), fresh, T, o).allow, true)
  const at60 = decide(usage(row(60)), fresh, T, o)
  assert.equal(at60.allow, false)
  assert.match(at60.message, /paused at 60%/)
  const { state, done } = approve(usage(row(60)), fresh, config)
  assert.deepEqual(done.map((r) => r.level), [60])
  assert.equal(decide(usage(row(79)), state, T, o).allow, true)
  assert.equal(decide(usage(row(80)), state, T, o).allow, false)
  // The default approve is still the default thresholds: at 60% there is nothing to approve.
  assert.deepEqual(approve(usage(row(60)), fresh).done, [])
})

// The weekly limit: a warning when usage runs ahead of the week, not only at a fixed 70%.
const NOW = Date.parse('2026-10-03T10:00:00Z')
const DAY = 86_400_000
const week = (used, daysLeft) => ({ name: 'seven_day', used, resets: new Date(NOW + daysLeft * DAY).toISOString() })

test('warns when the week is being used faster than it passes (more than 15 points ahead)', () => {
  // Five days left: two of seven days (29%) have passed.
  const ahead = decide(usage(row(10), week(45, 5)), fresh, NOW, opts)
  assert.equal(ahead.allow, true)
  assert.match(ahead.message, /weekly limit at 45%/)
  assert.match(ahead.message, /29% of the week/)
  assert.equal(decide(usage(row(10), week(40, 5)), fresh, NOW, opts).message, undefined)
  // Once per week.
  assert.equal(decide(usage(row(10), week(50, 5)), ahead.state, NOW, opts).message, undefined)
  // The margin is configurable.
  assert.equal(decide(usage(row(10), week(45, 5)), fresh, NOW, { ...opts, config: { warnAt: 70, stopAt: [90, 95], paceAhead: 20 } }).message, undefined)
})

test('late in the week a high weekly usage is on pace, but 70% still warns', () => {
  assert.equal(decide(usage(row(10), week(65, 1)), fresh, NOW, opts).message, undefined)
  assert.match(decide(usage(row(10), week(70, 1)), fresh, NOW, opts).message, /weekly limit at 70%/)
})

test('the 5-hour window has no pace warning, only the 70% one', () => {
  assert.equal(decide(usage({ name: 'five_hour', used: 60, resets: new Date(NOW + 4.5 * 3_600_000).toISOString() }), fresh, NOW, opts).message, undefined)
})
