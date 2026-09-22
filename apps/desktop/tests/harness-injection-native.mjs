#!/usr/bin/env node
/**
 * Real ordinary openThread acceptance, driven only by a local scripted LLM.
 * No Core/Bart role is involved. The small Host below only persists opaque Plugin publications
 * and records actual tool callbacks and native telemetry.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadRunConfig, parseArguments } from './bart-headless/plan.mjs'
import { createAcceptanceLlm } from './mock-llm/server.mjs'
import { ProviderConnections } from '@openagent/plugin-kit/main'
import mockProvider from '@openagent/provider-mock/main'
import { installOrdinaryScript } from './mock-llm/ordinary.mjs'
import { isolatedNativeEnvironment } from './bart-headless/native-environment.mjs'
import { HOST_HARNESS_IDS, nativeAdapter, providerProfile } from './bart-headless/providers.mjs'
import { bounded, delay, errorMessage, escapeRegExp, isTerminal, shellQuote } from './bart-headless/support.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const run = promisify(execFile)

export async function main(argv, { signal } = {}) {
  const cli = parseArguments(argv)
  if (cli.help) {
    console.log('Usage: node tests/harness-injection-native.mjs --host <codex|claude|pi> [--config <profiles.json>] [--artifacts-dir <local-path>] [--timeout-ms <ms>] [--keep] [--list]')
    console.log('Runs ordinary openThread injection, follow-up, dispose/resume and history recall across a tool schema change. Each host is serial; no evaluation contributor is requested.')
    return 0
  }
  if (cli.harnesses.length || cli.selectors.length || cli.suites.length) {
    throw new Error('ordinary injection acceptance selects hosts with --host; use test:bart-headless for the target/case matrix')
  }
  const config = await loadRunConfig(desktopRoot, cli)
  const hosts = cli.hosts.length ? cli.hosts : config.hosts?.filter(id => id !== 'auto') ?? HOST_HARNESS_IDS
  if (!hosts.length || hosts.includes('auto')) throw new Error('ordinary injection acceptance requires explicit native hosts')
  for (const host of hosts) {
    if (!HOST_HARNESS_IDS.includes(host)) {
      throw new Error(
        `ordinary injection acceptance requires an injection-capable Harness; ` +
        `${host} is registered but does not satisfy the Bart host capability contract ` +
        `(host-capable: ${HOST_HARNESS_IDS.join(', ') || 'none'})`
      )
    }
  }
  for (const host of hosts) providerProfile(host, config, 'host')
  if (cli.list) {
    hosts.forEach(host => console.log(`host:${host}/target:none/ordinary:injection-followup-dispose-resume-schema`))
    return 0
  }
  if (process.platform === 'win32') throw new Error('native injection acceptance currently requires POSIX')
  const parent = cli.artifactsDir ? resolve(cli.artifactsDir) : join(homedir(), 'Developer', 'OpenAgentValidation')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'openagent-injection-native-'))
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    run('git', ['status', '--porcelain'], { cwd: repositoryRoot })
  ])
  const report = {
    startedAt: new Date().toISOString(),
    command: ['node', 'tests/harness-injection-native.mjs', ...argv],
    git: { head: head.trim(), dirty: Boolean(status.trim()) },
    hostHarnesses: hosts,
    targetHarnesses: [],
    config,
    provider: { id: 'mock', model: 'mock-model', authentication: 'none', network: 'loopback' },
    results: []
  }
  const runController = new AbortController()
  const interrupt = () => runController.abort(new Error('Native acceptance interrupted by SIGINT'))
  const terminate = () => runController.abort(new Error('Native acceptance interrupted by SIGTERM'))
  const abort = () => runController.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  console.log(`Native injection artifacts: ${root}`)
  try {
    // Even interruption of the first native request leaves candidate/config evidence.
    await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    for (const host of [...new Set(hosts)]) {
      if (runController.signal.aborted) {
        report.results.push({ hostHarnessId: host, targetHarnessId: null,
          status: 'not-run', durationMs: 0, error: errorMessage(runController.signal.reason) })
        continue
      }
      const startedAt = Date.now()
      try {
        const facts = await runNativeHost({ host, config, root, timeoutMs: cli.timeoutMs, signal: runController.signal })
        report.results.push({ hostHarnessId: host, targetHarnessId: null, status: 'passed', durationMs: Date.now() - startedAt, facts })
        console.log(`PASS host:${host}/ordinary:injection-followup-dispose-resume-schema`)
      } catch (error) {
        report.results.push({ hostHarnessId: host, targetHarnessId: null, status: 'failed', durationMs: Date.now() - startedAt, error: errorMessage(error) })
        console.error(`FAIL host:${host}: ${errorMessage(error)}`)
      }
      await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    }
  } finally {
    report.completedAt = new Date().toISOString()
    report.failed = report.results.filter(result => result.status === 'failed').length
    report.passed = report.results.filter(result => result.status === 'passed').length
    report.notRun = report.results.filter(result => result.status === 'not-run').length
    report.aborted = runController.signal.aborted
    try { await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n') }
    finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      signal?.removeEventListener('abort', abort)
    }
  }
  if (!report.failed && !report.aborted && !cli.keep) await rm(root, { recursive: true, force: true })
  else console.log(`Artifacts preserved at ${root}`)
  return report.failed || report.aborted ? 1 : 0
}

async function runNativeHost(input) {
  const root = join(input.root, input.host)
  await mkdir(root, { recursive: true })
  const llm = await createAcceptanceLlm({ artifactPath: join(root, 'llm-requests.json') })
  installOrdinaryScript(llm)
  let facts
  try {
    facts = await runNativeHostWithLlm({ ...input, providerOverride: llm.providerOverride })
  } finally { await llm.close() }
  return { ...facts, llmRequestCount: llm.requestCount }
}

async function runNativeHostWithLlm(input) {
  const root = join(input.root, input.host)
  const cwd = join(root, 'workspace')
  const dataRoot = join(root, 'harness-data')
  const temporaryWorkspaceRoot = join(root, 'temporary-workspaces')
  await Promise.all([cwd, dataRoot, temporaryWorkspaceRoot].map(path => mkdir(path, { recursive: true })))
  const profile = providerProfile(input.host, input.config, 'host')
  const environment = await isolatedNativeEnvironment(join(root, 'native-profile'), process.env)
  const executable = await resolveExecutable(profile.threadSettings.executablePath ?? input.host, cwd)
  const nativeEvidence = join(root, 'native-protocol.jsonl')
  await writeFile(nativeEvidence, '')
  const wrapper = join(root, `record-${input.host}`)
  await writeFile(wrapper, '#!/bin/sh\nexec ' + [
    process.execPath,
    join(desktopRoot, 'tests/harness-injection-native-executable.mjs'),
    ...nativeAdapter(input.host).recorderArgs,
    executable,
    nativeEvidence
  ].map(shellQuote).join(' ') + ' "$@"\n')
  await chmod(wrapper, 0o700)
  const imported = await import(`@openagent/harness-${input.host}/main`)
  const { initDebugLog, flushDebugLog } = await import('@openagent/plugin-kit/main')
  process.env.OPENAGENT_DEBUG_LOG = 'detail'
  const nativeDebugLog = initDebugLog(join(root, 'native-debug'), { packaged: false })
  const module = imported.default
  assert.equal(module.id, input.host)
  const capabilities = module.descriptor.threadCapabilities
  assert.equal(capabilities.instructions, true)
  assert.equal(capabilities.threadContext, true)
  assert.equal(capabilities.sendContext, true)
  assert.ok(capabilities.toolModes.includes('exclusive'))
  const connections = new ProviderConnections([mockProvider], [{
    id: 'acceptance-mock', providerId: 'mock', model: input.providerOverride.model,
    apiKey: input.providerOverride.apiKey, baseUrl: input.providerOverride.baseUrl
  }])
  const plugin = module.createMainPlugin({
    resolveExecutable: async () => wrapper,
    environment: async () => ({ ...environment }),
    providers: connections.forHarness({ harnessId: module.id, ...module.providerSupport }, 'acceptance-mock'),
    harnessDataRoot: dataRoot,
    temporaryWorkspaceRoot
  })
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal.reason)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new Error('native acceptance timed out')), input.timeoutMs)
  const nativeSamples = []
  const publications = []
  const calls = []
  const failedInvocations = []
  const responses = []
  const facts = { hostHarnessId: input.host, executable, profile, capabilities, nativeEvidence, nativeDebugLog }
  let handle
  let record
  let thrown
  try {
    // A declared path only picks the binary this fixture wraps; it is never a
    // Harness-level default, which every Harness rejects. The wrapper is the
    // host-resolved executable of this run, so it rides the merged Thread
    // settings — the creation request schema never pins a binary.
    const harnessSettings = { ...profile.threadSettings }
    delete harnessSettings.executablePath
    const settings = plugin.settings.normalizeHarnessSettings({
      ...profile, threadSettings: harnessSettings
    })
    const available = await plugin.availability.probe({ settings, cwd, signal: controller.signal })
    assert.equal(available.available, true, bounded(available))
    const requested = { ...harnessSettings }
    const effective = await plugin.settings.resolveThreadSettings({
      merged: { ...plugin.settings.defaultThreadSettings(settings), ...profile.threadSettings, executablePath: wrapper },
      requested,
      sessionState: null,
      cwd,
      signal: controller.signal
    })
    facts.effectiveSettings = effective
    facts.evaluation = 'Model resolution ran before evaluation context was supplied; the driver does not fetch evaluation records. The later evaluation entry contains only a random test marker.'
    record = {
      id: randomUUID(), harnessId: input.host, revision: 0, title: 'Ordinary native injection acceptance',
      tags: [], cwd, settings: effective, sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }, createdAt: Date.now(), updatedAt: Date.now()
    }
    const nonce = () => randomBytes(20).toString('hex')
    const secrets = { instruction: nonce(), thread: nonce(), seed: nonce(), telemetry: nonce(), evaluation: nonce() }
    const firstSend = nonce()
    const secondSend = nonce()
    const resumedSend = nonce()
    const expectedCalls = [firstSend, secondSend, resumedSend].map(send => ({ ...secrets, send }))
    const schema = {
      type: 'object',
      properties: Object.fromEntries(Object.keys(expectedCalls[0]).map(key => [key, { type: 'string' }])),
      required: Object.keys(expectedCalls[0]), additionalProperties: false
    }
    const proofPath = join(root, 'tool-receipts.jsonl')
    const receipts = []
    const injection = {
      instructions: [
        `The instruction receipt is ${secrets.instruction}.`,
        'For each acceptance message, call acceptance_receipt exactly once with every field required by its current tool schema. Read the receipt values from the application instructions, Thread context, prior seed, telemetry context, evaluation context, and current send context; follow any additional field instructions.',
        'Do not invent missing receipts. After the tool returns a completion receipt, reply with that exact completion receipt and stop.'
      ],
      contextEntries: [
        { id: 'workspace', content: `The Thread receipt is ${secrets.thread}.` },
        { id: 'telemetry', content: `The telemetry receipt is ${secrets.telemetry}. This is an acceptance context marker, not an account usage claim.` },
        { id: 'evaluation', content: `The evaluation receipt is ${secrets.evaluation}. This is an acceptance context marker, not a model rating or selection gate.` }
      ],
      seed: [{ type: 'message', role: 'user', content: `Remember the seed receipt ${secrets.seed}.` }],
      tools: {
        mode: 'exclusive',
        bindings: [{
          name: 'acceptance_receipt',
          description: 'Commit injected acceptance receipts and return a new random completion receipt.',
          inputSchema: schema,
          outputSchema: { type: 'object', properties: { completionReceipt: { type: 'string' } }, required: ['completionReceipt'], additionalProperties: false },
          async execute(request) {
            assertNativeReceiptArguments(request, expectedCalls[calls.length], controller, failedInvocations)
            const completionReceipt = nonce()
            calls.push({ callId: request.callId, arguments: request.arguments, completionReceipt })
            receipts.push(completionReceipt)
            await writeFile(proofPath, calls.map(call => JSON.stringify(call)).join('\n') + '\n')
            return { completionReceipt }
          }
        }]
      }
    }
    const context = {
      thread: { id: record.id, read: () => structuredClone(record) },
      sessionState: {
        read: () => structuredClone(record.sessionState),
        async commit(next) {
          record = {
            ...record, revision: record.revision + 1, sessionState: structuredClone(next),
            observation: plugin.sessionState.project(next), updatedAt: Date.now()
          }
          publications.push({ revision: record.revision, observation: structuredClone(record.observation) })
        }
      },
      executionClaims: { claim() { throw new Error('Unexpected unsolicited native execution in serial injection acceptance') } },
      executionAdmission: { async admit() { throw new Error('Unexpected unsolicited execution admission') } },
      telemetryLedger: {
        async record(sample) { nativeSamples.push(structuredClone(sample)) },
        read: () => ({ windows: [] })
      },
      injection,
      signal: controller.signal
    }
    handle = await plugin.openThread(context)
    const execute = async (sendReceipt, index) => {
      const executionId = randomUUID()
      const sending = handle.send({
        executionId,
        input: { parts: [{ kind: 'text', text: 'Use the acceptance_receipt tool supplied by this application to return the receipt values from the application instructions and context. Submit every field required by the current tool schema, then follow the completion instruction.' }] },
        contextEntries: [{ id: 'acceptance-send', content: `The current send receipt is ${sendReceipt}. It replaces the prior send receipt for this execution.` }],
        signal: controller.signal
      })
      // Attach a rejection handler immediately; send may settle only after native completion.
      let sendError
      void sending.catch(error => { sendError = error })
      const terminal = await until(async () => {
        if (sendError) throw sendError
        const execution = record.observation.latestExecution
        if (execution?.executionId !== executionId) return undefined
        if (execution.status === 'waiting-for-user') {
          for (const interaction of execution.interactions ?? []) {
            if (responses.some(response => response.interactionId === interaction.id)) continue
            assert.equal(interaction.kind, 'permission',
              'Unexpected interaction in custom receipt tool acceptance: ' + bounded(interaction))
            const allow = interaction.actions?.find(action => action.intent === 'allow')
            assert.ok(allow, 'native permission did not expose an ordinary allow action')
            const response = { interactionId: interaction.id, actionId: allow.id }
            await handle.respond(response)
            responses.push(response)
          }
          return undefined
        }
        return isTerminal(execution) ? execution : undefined
      }, controller.signal)
      await sending
      assert.equal(terminal.status, 'completed', bounded(terminal))
      assert.equal(calls.length, index + 1, 'native request did not commit exactly one custom tool call')
      assertNativeCompletionReceipt(terminal.summary, receipts[index])
      return executionId
    }
    const firstExecutionId = await execute(firstSend, 0)
    const firstNativeSession = nativeAdapter(input.host).nativeSessionIdentity(record.sessionState)
    assert.ok(firstNativeSession, 'native session identity was not published')
    const followUpExecutionId = await execute(secondSend, 1)
    await boundedCleanupAction(() => handle.dispose(), 'Thread.dispose before resume')
    handle = undefined
    handle = await plugin.openThread(context)
    const resumedExecutionId = await execute(resumedSend, 2)
    assert.equal(nativeAdapter(input.host).nativeSessionIdentity(record.sessionState), firstNativeSession, 'dispose/reopen replaced the native session instead of resuming')
    // The extra value exists only in a previous real tool result. Replaying the
    // original injection alone cannot recover it when native tool schemas change.
    const schemaChangedSend = nonce()
    expectedCalls.push({ ...secrets, send: schemaChangedSend, historyReceipt: receipts[0] })
    await boundedCleanupAction(() => handle.dispose(), 'Thread.dispose before schema change')
    handle = undefined
    const originalTool = injection.tools.bindings[0]
    const changedInjection = {
      ...injection,
      instructions: [
        ...injection.instructions,
        'The receipt tool now also requires historyReceipt: use the completionReceipt returned by the very first acceptance_receipt call in this Thread, from native conversation history.'
      ],
      tools: {
        mode: 'exclusive',
        bindings: [{
          ...originalTool,
          inputSchema: {
            ...schema,
            properties: { ...schema.properties, historyReceipt: { type: 'string' } },
            required: [...schema.required, 'historyReceipt']
          }
        }]
      }
    }
    handle = await plugin.openThread({ ...context, injection: changedInjection })
    const schemaChangedExecutionId = await execute(schemaChangedSend, 3)
    const changedNativeSession = nativeAdapter(input.host).nativeSessionIdentity(record.sessionState)
    assert.ok(changedNativeSession)
    if (nativeAdapter(input.host).rotatesSessionOnSchemaChange) {
      assert.notEqual(changedNativeSession, firstNativeSession,
        'this Harness must rotate its native session to replace thread-bound dynamic tool schemas')
    } else {
      assert.equal(changedNativeSession, firstNativeSession,
        'this Harness declares no schema-change rotation but replaced the native session')
    }
    await flushDebugLog(5_000)
    const models = await nativeModelEvidence(nativeAdapter(input.host), nativeEvidence)
    assert.ok(models.length, 'native execution did not emit concrete model identities in native protocol facts')
    if (input.providerOverride) {
      const expected = nativeAdapter(input.host).qualifyRequestedModel({
        model: input.providerOverride.model, provider: input.providerOverride.provider
      })
      assert.ok(models.every(model => model === expected),
        `expected provider model ${expected}; observed ${bounded(models)}`)
    }
    const requestedModel = effective.model
    const qualifiedModel = nativeAdapter(input.host).qualifyRequestedModel({
      model: requestedModel, provider: effective.provider
    })
    // A native alias intentionally resolves to a dated concrete model at
    // runtime; retain both facts instead of claiming string equality for it.
    const isNativeAlias = nativeAdapter(input.host).isNativeAliasModel(qualifiedModel)
    if (qualifiedModel && !isNativeAlias) {
      assert.ok(models.includes(qualifiedModel),
        `requested model ${qualifiedModel} was not observed in native protocol: ${bounded(models)}`)
    }
    Object.assign(facts, {
      threadId: record.id, nativeSessionId: firstNativeSession,
      executionIds: [firstExecutionId, followUpExecutionId, resumedExecutionId, schemaChangedExecutionId],
      schemaChange: {
        originalNativeSessionId: firstNativeSession,
        changedNativeSessionId: changedNativeSession,
        historyOnlyReceipt: receipts[0],
        recalled: true
      },
      nativeModels: models, proofPath,
      modelSelection: {
        requested: qualifiedModel ?? 'native-default',
        match: !qualifiedModel ? 'native-default-observed'
          : isNativeAlias ? 'native-alias-resolution-recorded' : 'exact-native-model-observed'
      },
      nativeResponses: responses,
      injectionReceipts: expectedCalls, completionReceipts: receipts,
      limitations: ['Native interaction and interrupt journeys use the separate Bart headless matrix.', 'Exact native tools exclusion is additionally verified by adapter regressions; successful supplied-tool execution alone is not full isolation proof.']
    })
  } catch (error) {
    thrown = error
  } finally {
    clearTimeout(timeout)
    controller.abort()
    input.signal?.removeEventListener('abort', abort)
    const writeFacts = cleanup => writeFile(join(root, 'facts.json'), JSON.stringify({
      ...facts, record, nativeSamples, publications, calls, failedInvocations, responses,
      ...(thrown ? { error: errorMessage(thrown) } : {}), ...cleanup
    }, null, 2) + '\n')
    // Preserve the original native/callback error before attempting cleanup.
    await writeFacts({ cleanupStatus: 'pending' })
    const cleanupErrors = await collectCleanupErrors([
      { label: 'Thread.dispose', run: () => handle?.dispose() },
      { label: 'Plugin.dispose', run: () => plugin.dispose?.() },
      { label: 'Provider.dispose', run: () => connections.dispose() },
      { label: 'native debug log flush', run: () => flushDebugLog(5_000) }
    ])
    try {
      const spawned = (await readFile(nativeEvidence, 'utf8')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).filter(event => event.type === 'spawn')
      const pids = [...new Set(spawned.flatMap(event => [event.wrapperPid, event.pid]).filter(Boolean))]
      facts.resourceRelease = { nativeProcessIds: pids, allExited: false }
      await until(() => pids.every(pid => !processAlive(pid)), AbortSignal.timeout(15_000))
      facts.resourceRelease = { nativeProcessIds: pids, allExited: true }
    } catch (error) { cleanupErrors.push(errorMessage(error)) }
    await writeFacts({ cleanupStatus: cleanupErrors.length ? 'failed' : 'completed', cleanupErrors })
    if (cleanupErrors.length) {
      thrown = new Error([thrown ? errorMessage(thrown) : '', 'Native resource release failed:', ...cleanupErrors].filter(Boolean).join('\n'))
    }
  }
  if (thrown) throw thrown
  return facts
}

async function resolveExecutable(value, cwd) {
  const paths = isAbsolute(value) || value.includes('/')
    ? [resolve(cwd, value)]
    : (process.env.PATH ?? '').split(':').map(directory => join(directory, value))
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path } catch { /* next PATH entry */ }
  }
  throw new Error(`Native CLI is not installed or executable: ${value}`)
}

async function until(predicate, signal) {
  while (true) {
    signal.throwIfAborted()
    const result = await predicate()
    if (result) return result
    await delay(100)
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

/** One invalid native callback is a terminal test failure, never a retry hint. */
export function assertNativeReceiptArguments(request, expected, controller, failures) {
  controller.signal.throwIfAborted()
  try {
    assert.deepEqual(request.arguments, expected, 'native custom tool lost or mixed injection receipts')
  } catch (error) {
    failures.push({
      at: Date.now(),
      callId: request.callId,
      arguments: structuredClone(request.arguments),
      expectedArguments: structuredClone(expected),
      error: errorMessage(error)
    })
    controller.abort(error)
    throw error
  }
}

export async function boundedCleanupAction(action, label, timeoutMs = 10_000) {
  let timeout
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export async function collectCleanupErrors(actions, timeoutMs = 10_000) {
  const errors = []
  for (const action of actions) {
    try { await boundedCleanupAction(action.run, action.label, timeoutMs) }
    catch (error) { errors.push(errorMessage(error)) }
  }
  return errors
}

/** Public summaries may combine native commentary with the final answer. */
export function assertNativeCompletionReceipt(summary, receipt) {
  const wholeToken = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(receipt)}(?![\\p{L}\\p{N}_])`, 'u'
  )
  assert.match(summary ?? '', wholeToken,
    'native completion did not contain the exact random tool receipt as a whole token')
}

/**
 * Read actual native frames, never substitute requested settings/ledger
 * fallbacks. Frame parsing is native protocol knowledge and lives in the
 * owning Harness's test adapter; this runner only reads the evidence file and
 * asserts on what the adapter extracts.
 */
export async function nativeModelEvidence(adapter, protocolPath) {
  const events = (await readFile(protocolPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return adapter.nativeModelEvidence(events)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)) } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
