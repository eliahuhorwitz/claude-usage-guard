import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, parseConfig, readConfig } from '../src/config.mjs'

test('the defaults are 70, 90 and 95, and 15 points ahead of the week', () => {
  assert.deepEqual(DEFAULTS, { warnAt: 70, stopAt: [90, 95], paceAhead: 15 })
})

test('a config sets any of the three; the rest stay at the defaults', () => {
  assert.deepEqual(parseConfig({ stopAt: [85] }), { config: { warnAt: 70, stopAt: [85], paceAhead: 15 } })
  assert.deepEqual(parseConfig({ warnAt: 60, paceAhead: 10 }), { config: { warnAt: 60, stopAt: [90, 95], paceAhead: 10 } })
  assert.deepEqual(parseConfig({}), { config: { ...DEFAULTS } })
})

test('a bad config is refused as a whole, with the reason, and the defaults apply', () => {
  const bad = (raw, re) => {
    const r = parseConfig(raw)
    assert.equal(r.config, DEFAULTS)
    assert.match(r.problem, re)
  }
  bad(null, /not an object/)
  bad([90], /not an object/)
  bad({ stopat: [90] }, /unknown key "stopat"/)
  bad({ warnAt: 0 }, /warnAt/)
  bad({ warnAt: 101 }, /warnAt/)
  bad({ warnAt: '70' }, /warnAt/)
  bad({ warnAt: 70.5 }, /warnAt/)
  bad({ paceAhead: -1 }, /paceAhead/)
  bad({ stopAt: [] }, /stopAt/)
  bad({ stopAt: 90 }, /stopAt/)
  bad({ stopAt: [95, 90] }, /stopAt/)
  bad({ stopAt: [90, 90] }, /stopAt/)
  bad({ stopAt: [90, 'x'] }, /stopAt/)
  bad({ warnAt: 95, stopAt: [90] }, /warnAt must not be above the first stop/)
})

test('readConfig: no file means the defaults; a file is read; a broken file is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-guard-'))
  assert.deepEqual(readConfig(dir), { config: DEFAULTS })
  writeFileSync(join(dir, 'config.json'), '{ "stopAt": [80, 90, 95] }')
  assert.deepEqual(readConfig(dir), { config: { warnAt: 70, stopAt: [80, 90, 95], paceAhead: 15 } })
  writeFileSync(join(dir, 'config.json'), '{ stopAt: ')
  assert.match(readConfig(dir).problem, /not valid JSON/)
  assert.equal(readConfig(dir).config, DEFAULTS)
})
