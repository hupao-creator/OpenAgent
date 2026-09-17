import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2).filter(arg => arg !== '--')
const explore = args[0] === '--explore'
const replay = args[0] === '--replay'
if (explore || replay) args.shift()
if (replay && (process.env.FC_PATH === undefined || process.env.FC_SEED === undefined)) {
  console.error('Replay requires FC_SEED, FC_PATH and -t with one property name')
  process.exit(1)
}
const env = { ...process.env, ...(explore ? { FC_EXPLORE: '1' } : {}) }
if (env.FC_PATH !== undefined && (!env.FC_SEED || !args.includes('-t'))) {
  console.error('Replay requires FC_SEED and -t with one property name')
  process.exit(1)
}
// This process runs the entire property directory serially, including properties
// with 120-second internal budgets. Leave room for their structured failure reports.
for (const command of [
  ['--dir', 'apps/desktop', 'generate:registry'],
  ['--dir', 'apps/desktop', 'exec', 'vitest', 'run', 'tests/property', '--maxWorkers=1', ...args]
]) {
  const result = spawnSync('pnpm', command, { env, stdio: 'inherit', timeout: 900_000 })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
