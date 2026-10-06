// Run this yourself to let Claude Code continue past a stop, until the window resets:
//   ! node "<plugin folder>/src/approve.mjs"     (the hook's message gives the exact line)
import { readConfig } from './config.mjs'
import { approve } from './guard.mjs'
import { loadState, readUsage, saveState, stateDir } from './usage.mjs'

const dir = stateDir()
const { config, problem } = readConfig(dir)
if (problem) console.log(`config.json ignored (${problem}); using the defaults.`)
const usage = await readUsage()
if (usage.error) {
  console.log(`Could not read usage (${usage.error}); nothing approved.`)
  process.exit(1)
}
const { state, done } = approve(usage, loadState(dir), config)
saveState({ ...state, lastCheck: { at: Date.now(), usage } }, dir)
if (done.length === 0) console.log(`Nothing to approve: no limit is at ${config.stopAt[0]}% or more, or it is already approved.`)
for (const r of done) {
  const next = config.stopAt.find((l) => l > r.level)
  console.log(`Approved: ${r.name} at ${r.used}%, past the ${r.level}% stop, until it resets (${r.resets}).${next ? ` Work stops again at ${next}%.` : ''}`)
}
