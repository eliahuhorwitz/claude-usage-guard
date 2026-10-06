// Prints the plan usage, the thresholds and what the guard has approved:
//   node "<plugin folder>/src/status.mjs"
// With --shape, also the shape of the endpoint's answer (key names and types, no values), for
// seeing what changed when the guard says it cannot read the usage.
import { readConfig } from './config.mjs'
import { loadState, readUsage, stateDir } from './usage.mjs'

const dir = stateDir()
const { config, problem } = readConfig(dir)
const usage = await readUsage(undefined, { shape: process.argv.includes('--shape') })
console.log(JSON.stringify({ usage, thresholds: config, configProblem: problem, approved: loadState(dir).approved, stateDir: dir }, null, 2))
