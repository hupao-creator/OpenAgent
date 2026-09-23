import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadlessClient, startHeadless } from './bart-headless/headless.mjs'
import { bartThread, latestExecution, toolOperations } from './bart-headless/support.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '../..')
const mainPath = join(desktopRoot, 'out/main/index.js')
const outputRoot = resolve(process.argv[2] || join(desktopRoot, 'out/bart-prompt-ablation'))
const model = process.env.BART_ABLATION_MODEL || 'gpt-6-luna'
const effort = process.env.BART_ABLATION_EFFORT || 'low'
const repeats = Number(process.env.BART_ABLATION_REPEATS || 2)
const task = process.env.BART_ABLATION_TASK || '请计算 1729 × 37，并告诉我结果。'
const selected = process.env.BART_ABLATION_VARIANTS?.split(',')
const timeoutMs = 180_000
const cases = [
  { id: 'baseline', edits: [] },
  { id: 'no_delegation', edits: [[
    'const BART_SYSTEM_PROMPT = "Delegate work to independent Agent Threads and coordinate them with the supplied OpenAgent tools.";',
    'const BART_SYSTEM_PROMPT = "";'
  ]] }
]

if (!existsSync(mainPath)) throw new Error(`Build first: ${mainPath}`)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Invalid BART_ABLATION_REPEATS')
if (existsSync(outputRoot)) throw new Error(`Use a new output directory: ${outputRoot}`)
await mkdir(outputRoot, { recursive: true })
const original = (await readFile(mainPath, 'utf8')).replace(
  'const CODEX_DEFAULT_PERMISSION_MODE = "approve-for-me";',
  'const CODEX_DEFAULT_PERMISSION_MODE = "ask-for-approval";'
)
if (!original.includes('const CODEX_DEFAULT_PERMISSION_MODE = "ask-for-approval";')) {
  throw new Error('Cannot set common Codex permission preset for the experiment')
}
const trials = []
for (const variant of cases) {
  if (selected && !selected.includes(variant.id)) continue
  let source = original
  for (const [needle, replacement] of variant.edits) {
    const occurrences = source.split(needle).length - 1
    if (occurrences !== 1) {
      throw new Error(`${variant.id}: expected prompt text count, got ${occurrences}`)
    }
    source = source.replaceAll(needle, replacement)
  }
  const variantMain = join(desktopRoot, `out/main/bart-ablation-${variant.id}.js`)
  await writeFile(variantMain, source)
  for (let repeat = 0; repeat < repeats; repeat++) {
    const id = `${variant.id}-${repeat + 1}`
    const root = join(outputRoot, id)
    await mkdir(root, { recursive: true })
    const result = await runTrial({ id, root, variantMain })
    trials.push(result)
    await writeFile(join(outputRoot, 'results.json'), JSON.stringify({ model, effort, repeats, task, trials }, null, 2) + '\n')
    process.stdout.write(`${id}: ${result.status}, operations=${result.operations?.map(x => x.name).join(',') || '-'}, ${result.elapsedMs}ms\n`)
  }
}

async function runTrial({ id, root, variantMain }) {
  let headless
  let client
  const started = Date.now()
  const codexHome = join(root, 'codex-profile')
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    await copyFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(codexHome, 'auth.json'))
    await chmod(join(codexHome, 'auth.json'), 0o600)
    await writeFile(join(codexHome, 'config.toml'), `model = "${model}"\nmodel_reasoning_effort = "${effort}"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n`)
    headless = await startHeadless({
      electronMain: variantMain,
      desktopRoot,
      repositoryRoot,
      userData: join(root, 'user-data'),
      openAgentHome: join(root, 'openagent-home'),
      processLog: join(root, 'headless.log'),
      environment: { ...process.env, CODEX_HOME: codexHome, OPENAGENT_BART_HEADLESS_PROVIDER: '', OPENAGENT_PROVIDER_CONFIG: '' }
    })
    client = new HeadlessClient({ port: headless.port, timeoutMs })
    client.start()
    const before = await client.loadState()
    const settings = {
      ...before.settings,
      harnesses: {
        ...before.settings.harnesses,
        codex: { useDefaultThreadSettings: false, threadSettings: { model, effort } }
      },
      bart: {
        ...before.settings.bart,
        hostHarnessPreference: 'codex',
        targetHarnessIds: ['codex'],
        routingGuidance: null
      }
    }
    await client.invoke('app:update-settings', settings)
    await client.waitForState(state => bartThread(state), 'Bart host creation', timeoutMs)
    const submission = client.invoke('bart:submit', { input: { parts: [{ kind: 'text', text: task }] } })
    await submission
    await client.waitForBartIdle('Bart first turn completion', timeoutMs)
    // Allow the delegated Thread and automatic lifecycle event to settle.
    const stopAt = Date.now() + 90_000
    let state
    do {
      state = await client.loadState()
      const targets = state.threads.filter(thread => !thread.bart)
      if (targets.length && targets.every(thread => ['completed', 'failed', 'interrupted'].includes(latestExecution(thread)?.status)) && state.executions.length === 0) break
      if (!targets.length && state.executions.length === 0) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    } while (Date.now() < stopAt)
    await writeFile(join(root, 'state.json'), JSON.stringify(state, null, 2) + '\n')
    const host = bartThread(state)
    const operations = toolOperations(state).map(entry => ({
      name: entry.name, arguments: entry.arguments, result: entry.result,
      executionId: entry.executionId, isError: entry.isError
    }))
    const targets = state.threads.filter(thread => !thread.bart).map(thread => ({
      harnessId: thread.harnessId,
      status: latestExecution(thread)?.status,
      model: thread.settings?.model,
      transcript: thread.transcript
    }))
    const answerText = (host?.transcript || []).filter(entry => entry.type === 'message' && entry.role === 'assistant').map(entry => entry.content)
    return { id, status: latestExecution(host)?.status || 'unknown', elapsedMs: Date.now() - started,
      model: host?.settings?.model, summary: latestExecution(host)?.summary, operations, targets, answerText }
  } catch (error) {
    return { id, status: 'error', elapsedMs: Date.now() - started, error: String(error?.stack || error) }
  } finally {
    await client?.stop().catch(() => {})
    await headless?.close().catch(() => {})
    await rm(join(codexHome, 'auth.json'), { force: true })
  }
}
