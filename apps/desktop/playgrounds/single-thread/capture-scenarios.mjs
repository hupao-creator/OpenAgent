/**
 * Capture actual committed state through isolated headless Bart/native tools.
 * Run after pnpm build. Harness selection and every native dialect below come
 * from the owning Harness's test adapter; an unknown or adapter-less Harness
 * is a named failure, never a silent skip.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  canHostBart,
  loadNativeTestAdapters,
} from '@openagent/test-kit'
import {
  startHeadless,
  HeadlessClient,
} from '../../tests/bart-headless/headless.mjs'
import {
  BartDriver,
  exactCallDirective,
} from '../../tests/bart-headless/bart.mjs'
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const dir = resolve(
  process.argv[2] ||
    resolve(
      homedir(),
      'Developer',
      'OpenAgentValidation',
      `thread-lab-${Date.now()}`
    )
)
const adapters = await loadNativeTestAdapters({
  workspaceRoot: resolve(root, 'apps/desktop'),
})
const selectedHarnesses = process.argv.slice(3)
const harnesses = selectedHarnesses.length ? selectedHarnesses : Object.keys(adapters)
for (const h of harnesses) {
  // Own-property membership only: an inherited key like `toString` must stay
  // an unknown Harness instead of resolving through the prototype.
  if (!Object.hasOwn(adapters, h)) {
    throw new Error(
      `Unknown Harness: ${h}. Registered Harnesses with a test adapter: ${Object.keys(adapters).join(', ')}`,
    )
  }
}
function adapter(h) {
  return adapters[h]
}
const attempts = []
await mkdir(dir, { recursive: true })
await mkdir(`${dir}/workspace`)
await writeFile(`${dir}/secret.txt`, 'lab capture sample')
const host = await startHeadless({
  desktopRoot: resolve(root, 'apps/desktop'),
  electronMain: resolve(root, 'apps/desktop/out/main/index.js'),
  repositoryRoot: `${dir}/workspace`,
  userData: `${dir}/user-data`,
  openAgentHome: `${dir}/home`,
  processLog: `${dir}/headless.log`,
})
const client = new HeadlessClient({ port: host.port, timeoutMs: 100000 })
const bart = new BartDriver(client)
const entries = new Map()
const ids = []
let recording = true
function record(s) {
  if (!recording) return
  for (const t of s.threads.filter((t) => !t.bart)) {
    const e = t.observation.latestExecution
    const bg = !!t.observation.backgroundWork
    const kind = e?.interactions?.[0]?.kind
    let phase =
      kind === 'permission'
        ? 'approval'
        : kind === 'question'
        ? 'question'
        : e?.status ?? 'empty'
    if (bg) phase = phase === 'completed' ? 'background' : `background-${phase}`
    const key = `${t.harnessId}-${phase}`
    const old = entries.get(key)
    // Keep the latest committed observation without interpreting private session state.
    const weight = t.updatedAt
    if (old && old.weight >= weight) continue
    const file = `${dir}/${key}.state.json`
    writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
    entries.set(key, {
      harness: t.harnessId,
      scenario: phase,
      threadId: t.id,
      file,
      weight,
    })
    writeFileSync(
      resolve(dir, 'manifest.json'),
      JSON.stringify([...entries.values()], null, 2)
    )
    if (!old) console.log('CAPTURE', key, t.id)
  }
}
const observe = client.observe.bind(client)
client.observe = (s) => {
  observe(s)
  record(s)
}
async function call(name, args) {
  return bart.askForTool({
    name,
    expectedArguments: args,
    directive: exactCallDirective(
      'Collect actual Single Thread Lab states in this isolated workspace.',
      name,
      args
    ),
  })
}
async function start(h, prompt, options = {}) {
  const op = await call('thread_create', {
    harnessId: h,
    cwd: `${dir}/workspace`,
    worktree: false,
    options,
    prompt,
  })
  const id = op.result.threadId
  ids.push(id)
  return id
}
async function wait(id, status) {
  return client.waitForState(
    (s) => {
      const t = s.threads.find((t) => t.id === id)
      return status(t) ? t : undefined
    },
    `capture ${id}`,
    65000
  )
}
async function attempt(label, fn) {
  console.log('START', label)
  try {
    await fn()
    attempts.push({ label, status: 'captured' })
    console.log('DONE', label)
  } catch (e) {
    attempts.push({ label, status: 'unavailable', reason: String(e) })
    console.log('UNAVAILABLE', label, String(e).slice(0, 300))
  }
}
try {
  client.start()
  const s = await client.loadState()
  await client.invoke('app:update-settings', {
    ...s.settings,
    bart: {
      ...s.settings.bart,
      hostHarnessPreference: Object.keys(adapters).find(
        (id) => canHostBart(adapters[id].descriptor.threadCapabilities),
      ),
    },
  })
  console.log('HOST', host.port, dir)
  for (const h of harnesses) {
    await attempt(`${h} completed`, async () => {
      const id = await start(
        h,
        '请简短回答“搜索功能已完成验证”。不要调用工具。'
      )
      await wait(
        id,
        (t) => t?.observation.latestExecution?.status === 'completed'
      )
    })
    await attempt(`${h} permission`, async () => {
      const a = adapter(h)
      const permissionTool = a.nativeTools.permission
      if (!permissionTool) throw new Error(`Adapter does not name a native permission tool`)
      const prompt = `请用原生 ${permissionTool} 工具执行 printf lab > '${dir}/workspace/permission-${h}.txt'。${a.scenarioDialect?.permissionEscalation ?? ''}不要绕过权限请求。`
      const options = a.observationThreadSettings
      const id = await start(h, prompt, options)
      await wait(
        id,
        (t) => t?.observation.latestExecution?.status === 'waiting-for-user'
      )
      await bart.bestEffortInterrupt(id)
    })
    await attempt(`${h} question`, async () => {
      const a = adapter(h)
      const { plan: planTool, question: questionTool } = a.nativeTools
      if (!planTool || !questionTool) {
        throw new Error(`Adapter does not name native plan/question tools`)
      }
      const id = await start(
        h,
        `先用原生 ${planTool} 工具建立“确认搜索范围、实现搜索、验证结果”三步计划，第一步进行中。然后用原生 ${questionTool} 工具询问“搜索需要覆盖哪些内容？”，选项“项目名称”和“名称与描述”。不要自行回答，等待用户选择。`
      )
      await wait(id, (t) =>
        t?.observation.latestExecution?.interactions?.some(
          (i) => i.kind === 'question'
        )
      )
      await bart.bestEffortInterrupt(id)
    })
    await attempt(`${h} failed`, async () => {
      // The runner owns the scratch directory; the adapter owns the settings
      // shape that points a run at a non-existent executable. A Harness whose
      // settings cannot pin an executable (the host always resolves it)
      // declares the scenario unsupported instead of failing differently.
      const failureSettings = adapter(h).missingExecutableThreadSettings(h)
      if (!failureSettings) {
        throw new Error('Adapter does not support a missing-executable failure via Thread options')
      }
      const id = await start(h, '只回答完成。', {
        ...failureSettings,
        executablePath: `${dir}/missing-${h}-executable`,
      })
      await wait(id, t => t?.observation.latestExecution?.status === 'failed')
    })
  }
  for (const h of harnesses)
    await attempt(`${h} background`, async () => {
      const a = adapter(h)
      const dialect = a.scenarioDialect
      // Background work rides the Harness's command tool: an explicit
      // backgroundTool when the CLI has a dedicated one, otherwise the
      // permission tool named by the adapter.
      const backgroundTool = dialect?.backgroundTool ?? a.nativeTools.permission
      if (!backgroundTool || !dialect?.backgroundLaunchFlags) {
        throw new Error(`Adapter does not describe native background work`)
      }
      const prompt = `请用原生 ${backgroundTool} 工具执行 sleep 150，${dialect.backgroundLaunchFlags}。工具返回后立即回答‘后台检查已启动’，不要等待或读取结果。`
      const options = a.permissiveThreadSettings
      const id = await start(h, prompt, options)
      await wait(id, (t) => !!t?.observation.backgroundWork)
      await wait(
        id,
        (t) => t?.observation.latestExecution?.status === 'completed'
      )
      if (!dialect.backgroundFollowUp) {
        throw new Error(`Adapter does not describe the background follow-up send`)
      }
      await call('thread_send', {
        threadId: id,
        prompt: dialect.backgroundFollowUp,
      })
      await new Promise((r) => setTimeout(r, 2000))
      await client.loadState()
      await bart.bestEffortInterrupt(id)
    })
  // Reports use only real thread relationships created by the native Core tools.
  const reportState = await client.loadState()
  const related = reportState.threads.filter(thread => ids.includes(thread.id) &&
    thread.observation.latestExecution?.status === 'completed').slice(0, 6).map(thread => ({
      threadId: thread.id, executionId: thread.observation.latestExecution.executionId
    }))
  for (const [scenario, title, html, relations] of [
    [
      'summary',
      '搜索功能交付报告',
      '<h1>搜索功能交付报告</h1><p>已验证搜索结果、权限交互和任务执行状态。</p>',
      related.slice(0, 3),
    ],
    ['empty', '待补充报告', '', []],
    [
      'overflow',
      '跨 Harness 工作区任务执行与权限交互完整验证结果及后续改进建议报告',
      '<p>' +
        '验证涵盖任务状态、权限交互、消息排序和交付结果。'.repeat(8) +
        '</p>',
      related,
    ],
  ])
    await attempt(`report ${scenario}`, async () => {
      const op = await call('report_create', {
        title,
        html: html || '<html><body></body></html>',
        relatedExecutions: relations,
      })
      const id = op.result.reportId ?? op.result.id
      const state = await client.loadState()
      const report =
        state.reports.find((r) => r.id === id) ??
        state.reports.find((r) => r.title === title)
      const file = `${dir}/report-${scenario}.state.json`
      await writeFile(file, JSON.stringify(state, null, 2) + '\n')
      entries.set(`report-${scenario}`, {
        harness: 'report',
        scenario,
        threadId: report.id,
        file,
      })
      if (scenario === 'summary') {
        await call('report_set_archived', {
          reportId: report.id,
          archived: true,
        })
        const a = await client.loadState()
        const f = `${dir}/report-archived.state.json`
        await writeFile(f, JSON.stringify(a, null, 2) + '\n')
        entries.set('report-archived', {
          harness: 'report',
          scenario: 'archived',
          threadId: report.id,
          file: f,
        })
      }
    })
} finally {
  recording = false
  writeFileSync(
    resolve(dir, 'manifest.json'),
    JSON.stringify([...entries.values()], null, 2)
  )
  writeFileSync(
    resolve(dir, 'attempts.json'),
    JSON.stringify(attempts, null, 2)
  )
  for (const id of ids) await bart.bestEffortInterrupt(id).catch(() => {})
  await client.stop()
  await host.close()
  console.log('FINISHED', dir)
}
