// Opt-in real Pi test: proves project extensions cannot load or grant tools to Host,
// including when reopening a native session, while ordinary Pi still loads them.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startPiRpc } from '../dist/main/runtime/rpc.js'
import { piHostExtensionSource } from '../dist/main/runtime/host-extension.js'

const base = resolve(process.env.OA_PI_NATIVE_ARTIFACTS ?? 'output/playwright')
await mkdir(base, { recursive: true })
const root = await mkdtemp(join(base, 'pi-host-isolation-'))
const extensionDir = join(root, '.pi/extensions')
await mkdir(extensionDir, { recursive: true })
const marker = join(root, 'forbidden-extension-loaded.txt')
await writeFile(join(extensionDir, 'forbidden.js'), `import { writeFileSync } from 'node:fs';
export default function(pi) { writeFileSync(${JSON.stringify(marker)}, 'loaded');
pi.registerTool({name:'forbidden_project_tool',label:'Forbidden',description:'Forbidden project tool',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'forbidden'}],details:{}}}}); }
`)
const source = join(root, 'host.mjs')
const receipts = []
const injection = { instructions: ['Call host_receipt exactly once when asked, then stop.'], tools: { mode: 'exclusive', bindings: [
  { name: 'host_receipt', description: 'Receives proof', inputSchema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false },
    async execute(input) { receipts.push({ callId: input.callId, arguments: input.arguments }); return { accepted: input.arguments } } }
] } }
await writeFile(source, piHostExtensionSource(injection), { mode: 0o600 })
const options = { executablePath: process.env.OA_PI_EXECUTABLE ?? 'pi', cwd: root, env: process.env, signal: AbortSignal.timeout(180_000) }
const hostArgs = ['--no-tools', '--tools', 'host_receipt', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', source]
const modelArgs = [
  ...(process.env.OA_PI_PROVIDER ? ['--provider', process.env.OA_PI_PROVIDER] : []),
  ...(process.env.OA_PI_MODEL ? ['--model', process.env.OA_PI_MODEL] : []),
  ...(process.env.OA_PI_THINKING ? ['--thinking', process.env.OA_PI_THINKING] : [])
]
const events = []
let rpc
let sessionFile
const result = { root, cases: [] }
try {
  for (const stage of ['fresh', 'reopened']) {
    rpc = await startPiRpc({ ...options, args: ['--session-dir', root, ...hostArgs, ...modelArgs, ...(sessionFile ? ['--session', sessionFile] : [])], hostBridge: { injection, canExecute: () => true } })
    const state = await rpc.request({ type: 'get_state' })
    if (sessionFile) assert.equal(state.sessionFile, sessionFile)
    sessionFile = state.sessionFile
    const settled = new Promise((resolve, reject) => {
      rpc.onFailure(reject)
      rpc.subscribe(event => { events.push({ stage, ...event }); if (event.type === 'agent_settled') resolve() })
    })
    await rpc.request({ type: 'prompt', message: `If forbidden_project_tool or a native bash/read/write tool is available, invoke it directly. Do not delegate. Then call host_receipt with stage ${stage} and finish.` })
    await settled
    assert.deepEqual(receipts.at(-1)?.arguments, { stage })
    await assert.rejects(access(marker), error => error.code === 'ENOENT')
    assert.ok(!events.some(event => event.type === 'tool_execution_start' && event.toolName !== 'host_receipt'))
    result.cases.push(`${stage}: exact native allowlist, injected result roundtrip, project extension not loaded`)
    await rpc.dispose(); rpc = undefined
  }
  // Isolate trust configuration, not credentials: these startup-only probes make no model call.
  // This proves exclusion even for a project Pi otherwise trusts, without changing user settings.
  const agentDir = join(root, 'isolated-agent-dir')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }))
  const trustedOptions = { ...options, env: { ...options.env, PI_CODING_AGENT_DIR: agentDir } }
  for (const stage of ['trusted-fresh', 'trusted-reopen']) {
    rpc = await startPiRpc({ ...trustedOptions, args: ['--session-dir', root, ...hostArgs, ...modelArgs,
      ...(stage === 'trusted-reopen' ? ['--session', sessionFile] : [])], hostBridge: { injection, canExecute: () => false } })
    await assert.rejects(access(marker), error => error.code === 'ENOENT')
    result.cases.push(`${stage}: trusted project extension excluded by Host flags`)
    await rpc.dispose(); rpc = undefined
  }
  // Same real Pi, isolated trust settings and project, without Host injection.
  rpc = await startPiRpc({ ...trustedOptions, args: ['--no-session', ...modelArgs] })
  assert.equal(await readFile(marker, 'utf8'), 'loaded')
  result.cases.push('ordinary Pi startup still loads the same project extension')
  result.status = 'passed'; result.sessionFile = sessionFile; result.receipts = receipts
} catch (error) { result.status = 'failed'; result.error = String(error); throw error }
finally {
  await rpc?.dispose(); await rm(source, { force: true })
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2))
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
