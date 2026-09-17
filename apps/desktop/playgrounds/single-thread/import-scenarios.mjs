/** Build a curated scenario catalog; snapshots remain byte-identical and local. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = process.env.OPENAGENT_THREAD_LAB_SNAPSHOTS || fileURLToPath(new URL('../../../../.agents/local/thread-lab-snapshots/', import.meta.url))
const inputs = process.argv.slice(2)
if (!inputs.length) throw new Error('Usage: node import-scenarios.mjs <capture-manifest.json> [...]')
await mkdir(directory, { recursive: true })
const cases = new Map()
const agents = new Set(['empty', 'running', 'completed', 'approval', 'question', 'interrupted', 'failed', 'background', 'background-running', 'background-approval', 'background-question', 'background-interrupted', 'background-failed'])
const reports = new Set(['summary', 'empty', 'overflow', 'missing', 'archived'])
for (const input of inputs) {
  const entries = JSON.parse(await readFile(input, 'utf8'))
  for (const entry of entries) {
    const { harness, scenario, threadId, file } = entry
    if (![harness, scenario, threadId, file].every(value => typeof value === 'string' && value.length)) throw new Error('Invalid capture manifest entry')
    if (!['codex', 'claude', 'report'].includes(harness) || !(harness === 'report' ? reports : agents).has(scenario)) throw new Error('Unknown Harness/scenario')
    const bytes = await readFile(file)
    const state = JSON.parse(bytes)
    const records = harness === 'report' ? state.reports : state.threads
    const record = records?.find(item => item.id === threadId)
    if (!record || (harness !== 'report' && record.harnessId !== harness)) throw new Error(`Capture does not contain ${harness}/${threadId}`)
    if (harness !== 'report') {
      const execution = record.observation?.latestExecution
      const interaction = execution?.interactions?.[0]?.kind
      let actual = interaction === 'permission' ? 'approval' : interaction === 'question' ? 'question' : execution?.status ?? 'empty'
      if (record.observation?.backgroundWork) actual = actual === 'completed' ? 'background' : `background-${actual}`
      if (actual !== scenario) throw new Error(`${harness}/${scenario}: public observation is ${actual}`)
    } else {
      const missing = record.relatedExecutions.some(ref => !state.threads.some(thread => thread.id === ref.threadId))
      const valid = scenario === 'summary' ? !!record.previewText && record.relatedExecutions.length > 0
        : scenario === 'empty' ? !record.previewText && record.relatedExecutions.length === 0
        : scenario === 'overflow' ? !!record.previewText && record.relatedExecutions.length > 2
        : scenario === 'missing' ? missing
        : scenario === 'archived' ? record.archived : false
      if (!valid) throw new Error(`Report does not demonstrate ${scenario}`)
    }
    const snapshot = createHash('sha256').update(bytes).digest('hex')
    await writeFile(resolve(directory, `${snapshot}.json`), bytes)
    cases.set(`${harness}/${scenario}`, { harness, scenario, threadId, snapshot })
  }
}
const temporary = resolve(directory, 'cases.json.tmp')
await writeFile(temporary, JSON.stringify({ cases: [...cases.values()] }, null, 2) + '\n')
await rename(temporary, resolve(directory, 'cases.json'))
console.log(`Prepared ${cases.size} real scenarios`)
