// Prints the plan usage, the thresholds and what the guard has approved:
//   node "<plugin folder>/src/status.mjs"
import { readConfig } from './config.mjs'
import { loadState, readUsage, stateDir } from './usage.mjs'

const dir = stateDir()
const { config, problem } = readConfig(dir)
const usage = await readUsage()
console.log(JSON.stringify({ usage, thresholds: config, configProblem: problem, approved: loadState(dir).approved, stateDir: dir }, null, 2))
