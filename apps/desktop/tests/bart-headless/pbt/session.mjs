import { check } from '../invariant.mjs'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BartDriver } from '../bart.mjs'
import { HeadlessClient, startHeadless } from '../headless.mjs'
import { assertProviderModel, configureHost, nativeModels } from '../host.mjs'
import { isolatedNativeEnvironment } from '../native-environment.mjs'
import { HARNESS_IDS, nativeAdapter } from '../providers.mjs'
import { ScenarioContext } from '../scenario.mjs'
import { bartThread } from '../support.mjs'
import { assertPublicObservation } from './model.mjs'
import { createAcceptanceLlm } from '../../mock-llm/server.mjs'
import { installBartScript } from '../../mock-llm/bart.mjs'
import { installMetadataScript } from '../../mock-llm/metadata.mjs'
import { installStreamingScript } from '../../mock-llm/streaming.mjs'
import { installTargetScript } from '../../mock-llm/target.mjs'
import { RequestGates } from './gates.mjs'
import { SampleResources } from './resources.mjs'

/**
 * One isolated sample: a private Mock LLM, a private headless Electron process,
 * and the private Bart conversation that process owns. Every generated sample
 * and every shrink attempt gets a fresh one, so a leaked native subprocess,
 * listening port, or persisted Thread store can never span samples.
 *
 * The session exposes only the same public surfaces the fixed matrix uses:
 * bart:submit directives, committed renderer state, and the loopback command
 * plane. It never inspects product internals to build expectations.
 */
export async function openPbtSession(input) {
  input.signal?.throwIfAborted()
  const sampleRoot = join(input.samplesRoot, input.token)
  const proofRoot = join(sampleRoot, 'proofs')
  await mkdir(proofRoot, { recursive: true })

  const gates = new RequestGates(input.signal)
  const resources = new SampleResources(input.token, join(sampleRoot, 'resources.json'))
  const llm = await createAcceptanceLlm({
    artifactPath: join(sampleRoot, 'llm-requests.json'),
    beforeReply: request => gates.beforeReply(request)
  })
  installTargetScript(llm, HARNESS_IDS.map(nativeAdapter))
  installBartScript(llm)
  installMetadataScript(llm, HARNESS_IDS.map(nativeAdapter))
  installStreamingScript(llm)

  let headless
  let client
  try {
    headless = await startHeadless({
      signal: input.signal,
      electronMain: input.electronMain,
      desktopRoot: input.desktopRoot,
      repositoryRoot: input.repositoryRoot,
      userData: join(sampleRoot, 'user-data'),
      openAgentHome: join(sampleRoot, 'openagent-home'),
      environment: {
        ...await isolatedNativeEnvironment(join(sampleRoot, 'native-profile'), process.env),
        OPENAGENT_PBT_SAMPLE: input.token,
        OPENAGENT_BART_HEADLESS_PROVIDER: 'mock',
        OPENAGENT_MOCK_LLM_URL: llm.url
      },
      processLog: join(sampleRoot, 'headless.log')
    })
    client = new HeadlessClient({ port: headless.port, timeoutMs: input.timeoutMs, signal: input.signal })
    client.start()
    const host = await configureHost(client, input.host, input.config)
    input.onHostConfigured?.(host)
    const bart = new BartDriver(client)
    // Marker/scope tokens reach the Mock inside prompts, and a Mock prompt is
    // scripted by recognising an uppercase marker. A lowercase sample token
    // would be truncated at its first lowercase letter, so the context token —
    // the base every marker, sub-token, and proof path derives from — is
    // uppercased here, once. Directory and label names keep the readable token.
    const contextToken = input.token.replace(/[^a-z0-9]+/gi, '_').toUpperCase()
    const context = new ScenarioContext({
      client,
      bart,
      harness: input.target,
      host,
      config: input.config,
      suiteId: 'pbt',
      caseId: input.property,
      label: `${input.property}/${host.actualHost}/${input.target}/${input.token}`,
      runRoot: sampleRoot,
      proofRoot,
      repositoryRoot: input.repositoryRoot,
      openAgentHome: join(sampleRoot, 'openagent-home'),
      token: contextToken
    })
    return new PbtSession({ input, sampleRoot, proofRoot, llm, gates, resources, headless, client, bart, context, host })
  } catch (error) {
    // A session that never finished opening still owns whatever it created.
    const cleanup = []
    for (const step of [
      () => client?.stop(),
      () => headless?.close(),
      () => resources.assertReleased(),
      () => gates.releaseAll(),
      () => llm.close()
    ]) {
      try { await step() } catch (failure) { cleanup.push(failure) }
    }
    if (cleanup.length) {
      throw new AggregateError([error, ...cleanup], `sample ${input.token} failed to open and did not clean up`)
    }
    throw error
  }
}

class PbtSession {
  constructor(state) {
    this.input = state.input
    this.sampleRoot = state.sampleRoot
    this.proofRoot = state.proofRoot
    this.llm = state.llm
    this.gates = state.gates
    this.resources = state.resources
    this.headless = state.headless
    this.client = state.client
    this.bart = state.bart
    this.context = state.context
    this.host = state.host
    this.markerSequence = 0
    this.scopeSequence = 0
  }

  /** A sibling control surface with its own marker token and proof paths. */
  scoped(token) {
    return this.context.withToken(token)
  }

  /**
   * A marker that no other command in this session can collide with. Reusing one
   * marker string across commands would let a stale native turn match a fresh
   * gate, or let a stale completion satisfy a fresh assertion.
   */
  marker(kind) {
    this.markerSequence += 1
    return `${kind}:${this.context.token}M${this.markerSequence}`
  }

  /**
   * A fresh per-Thread token. Permission proofs are files on disk and the
   * approved marker is a substring of the terminal summary, so two Threads in
   * one session must never share a token: the second denial would find the first
   * approval's proof file and read it as evidence that it happened.
   */
  scope() {
    this.scopeSequence += 1
    return this.context.subToken(`S${this.scopeSequence}`)
  }

  /** Committed public observation for one Agent Thread, or its absence. */
  async observe(threadId) {
    await this.resources.capture()
    const state = await this.client.loadState()
    const thread = state.threads.find(candidate => candidate.id === threadId)
    if (!thread) return { exists: false, archived: null, latestExecution: null, backgroundWork: null }
    return {
      exists: true,
      archived: thread.archived === true,
      latestExecution: thread.observation?.latestExecution ?? null,
      backgroundWork: thread.observation?.backgroundWork ?? null,
      nativeModels: nativeModels(thread)
    }
  }

  /** Committed state must still satisfy the independent model. */
  async assertObserved(entry, label) {
    if (entry.threadId === null) {
      assertPublicObservation(label, { exists: false }, entry)
      return
    }
    assertPublicObservation(label, await this.observe(entry.threadId), entry)
  }

  /**
   * Evidence that the chain really ran on the native CLI, read out of each
   * Thread's own committed native session state.
   *
   * A native turn that was interrupted, or removed, before the model ever
   * replied has no assistant message to carry a provider and model, and that is
   * a legitimate state for a life-cycle property to produce. An Execution the
   * product itself reports as `completed` is not: it must name the provider and
   * model it ran on, and every Thread that does carry evidence must name the
   * Mock provider and model rather than anything else.
   *
   * `requireEvidence` additionally demands at least one surviving Thread with
   * evidence when the independent checkpoint model expects a surviving completed
   * Thread. Other sequences may not — removing every
   * Thread it created, or interrupting each one before the model replied, is a
   * legitimate outcome and not a vacuous pass.
   */
  async assertNativeModels(label, { requireEvidence = false } = {}) {
    const state = await this.client.loadState()
    const hostThread = bartThread(state)
    check.ok('native-model.host-thread-present', hostThread, `${label}: Bart Thread is missing`)
    check.equal('native-model.host-identity', hostThread.harnessId, this.host.actualHost,
      `${label}: Bart host changed after configuration`)
    assertProviderModel(hostThread, this.llm.providerOverride, 'host')
    let withEvidence = 0
    for (const threadId of this.context.threads) {
      const thread = state.threads.find(candidate => candidate.id === threadId)
      if (!thread) continue
      if (!nativeModels(thread).length) {
        check.notEqual('native-model.completed-target.present',
          thread.observation?.latestExecution?.status,
          'completed',
          `${label}: completed Thread ${threadId} carries no native model evidence`
        )
        continue
      }
      withEvidence += 1
      assertProviderModel(thread, this.llm.providerOverride)
    }
    if (requireEvidence) {
      check.ok('native-model.checkpoint.evidence-present', withEvidence > 0, `${label}: no Thread carried native model evidence`)
    }
  }

  /**
   * Bounded post-condition window. A late native result is delivered
   * asynchronously, so a single observation cannot prove its absence; this
   * re-reads committed state until it has been quiet for the whole window.
   */
  async assertStable(entry, check, label, windowMs = 1_000) {
    const deadline = Date.now() + windowMs
    do {
      const observation = await this.observe(entry.threadId)
      assertPublicObservation(label, observation, entry)
      check(observation)
      if (Date.now() >= deadline) break
      await this.client.nextChange(Math.min(200, deadline - Date.now()))
    } while (Date.now() < deadline)
    const finalObservation = await this.observe(entry.threadId)
    assertPublicObservation(label, finalObservation, entry)
    check(finalObservation)
  }

  /** The same elapsed-time window for a Thread that must not return. */
  async assertAbsent(threadId, label) {
    await this.assertStable({ threadId, deleted: true }, () => {}, label)
  }

  /**
   * Teardown: stop the observation client, terminate the headless/native process
   * trees, then release every gate and drain the Mock LLM. Releasing a held turn
   * first can start new native follow-up requests while shutdown is killing their
   * writers, leaving truncated HTTP bodies. Keep the response parked until all
   * its consumers are gone. Every step runs even when an earlier one fails.
   *
   * This deliberately does not ask the Bart host to interrupt the Threads that a
   * generated sequence can leave running. That request drives a whole host turn
   * and first waits for the host to become idle, bounded only by the full
   * per-request timeout: measured at 180s for one sample, and 542s across three.
   * A sequence that legitimately ends mid-Execution would then spend more than
   * the whole sample budget on politeness, and the run would be cut off by the
   * time limit and reported as a property failure.
   *
   * Terminating the process tree is the cleanup that matters, and the harness
   * owns it. The property assertions have finished, so nothing downstream
   * needs the Thread to reach a terminal state first, and the native CLIs are
   * spawned detached in their own process groups, which the product kills from
   * its own before-quit drain.
   */
  async close() {
    const errors = []
    for (const step of [
      () => this.resources.capture(),
      () => this.client.stop(),
      () => this.headless.close(),
      () => this.resources.assertReleased(),
      () => this.gates.releaseAll(),
      () => this.assertPortReleased(this.headless.port),
      () => this.llm.close(),
      () => this.assertPortReleased(Number(new URL(this.llm.url).port))
    ]) {
      try { await step() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, `sample ${this.input.token} cleanup failed`)
  }

  /** A terminated process tree must also release its loopback listener. */
  assertPortReleased(port) {
    return new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', error => reject(new Error(
        `sample port ${port} is still held: ${error.code}`
      )))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  }
}
