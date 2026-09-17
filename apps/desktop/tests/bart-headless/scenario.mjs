import assert from 'node:assert/strict'
import { check } from './invariant.mjs'
import { execFile } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { exactCallDirective, orderedCallDirective } from './bart.mjs'
import {
  permissiveProviderOptions,
  provider,
  providerOptions
} from './providers.mjs'
import {
  bounded,
  isTerminal,
  latestExecution,
  requiredString,
  shellQuote,
  TERMINAL_STATUSES
} from './support.mjs'

const run = promisify(execFile)

/**
 * The per-case control surface. It owns nothing durable: identifiers, proof
 * files, and temporary Git repositories are all scoped to one case so cases in
 * the same worker — and workers running in parallel — never collide.
 */
export class ScenarioContext {
  constructor(input) {
    this.client = input.client
    this.bart = input.bart
    this.harness = input.harness
    this.host = input.host
    this.provider = provider(input.harness)
    this.config = input.config
    this.suiteId = input.suiteId
    this.caseId = input.caseId
    this.label = input.label
    this.runRoot = input.runRoot
    this.proofRoot = input.proofRoot
    this.repositoryRoot = input.repositoryRoot
    this.openAgentHome = input.openAgentHome
    this.token = input.token
    this.threads = new Set()
  }

  /**
   * A sibling context that shares the run, the Bart, and the Thread registry
   * but owns its own marker token, so one case can drive several Threads whose
   * native proofs can never be confused with each other.
   */
  withToken(token) {
    const scoped = new ScenarioContext({
      client: this.client,
      bart: this.bart,
      harness: this.harness,
      host: this.host,
      config: this.config,
      suiteId: this.suiteId,
      caseId: this.caseId,
      label: this.label,
      runRoot: this.runRoot,
      proofRoot: this.proofRoot,
      repositoryRoot: this.repositoryRoot,
      openAgentHome: this.openAgentHome,
      token
    })
    scoped.threads = this.threads
    return scoped
  }

  subToken(suffix) {
    return `${this.token}_${suffix.toUpperCase()}`
  }

  proofPath(suffix = 'PROOF') {
    return join(this.proofRoot, `${this.token}_${suffix}.txt`)
  }

  options(overrides) {
    return providerOptions(this.harness, this.config, overrides)
  }

  /** Native profile that lets the agent act without a permission interaction. */
  permissiveOptions(overrides = {}) {
    return {
      ...permissiveProviderOptions(this.harness, this.config),
      ...structuredClone(overrides)
    }
  }

  startArguments(input) {
    return {
      harnessId: this.harness,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      options: input.options,
      prompt: input.prompt
    }
  }

  /** Starts one Agent Thread through the real Bart start tool. */
  async start(input) {
    const startArguments = this.startArguments(input)
    const operation = await this.bart.askForTool({
      name: 'openagent_thread_start',
      expectedArguments: startArguments,
      timeoutMs: input.timeoutMs,
      directive: exactCallDirective(
        input.intro || `Run one native ${this.harness} acceptance case.`,
        'openagent_thread_start',
        startArguments,
        ['Do not call respond, interrupt, delete, or any direct IPC.']
      )
    })
    const threadId = requiredString(operation.result?.threadId, 'start threadId')
    this.threads.add(threadId)
    return { threadId, operation, startArguments }
  }

  async waitForTerminal(threadId, timeoutMs) {
    const thread = await this.client.waitForThread(threadId, candidate => {
      const execution = latestExecution(candidate)
      return isTerminal(execution) ? candidate : undefined
    }, `thread ${threadId} terminal`, timeoutMs)
    return latestExecution(thread)
  }

  async waitForCompleted(threadId, timeoutMs) {
    const execution = await this.waitForTerminal(threadId, timeoutMs)
    check.equal('native.completed',
      execution.status,
      'completed',
      `native work did not complete: ${bounded(execution)}`
    )
    return execution
  }

  /** Waits for a native interaction and refuses any earlier terminal state. */
  async waitForInteraction(threadId, kind, timeoutMs) {
    const thread = await this.client.waitForThread(threadId, candidate => {
      const execution = latestExecution(candidate)
      if (execution?.status === 'waiting-for-user') return candidate
      if (execution && TERMINAL_STATUSES.has(execution.status)) {
        check.fail('interaction.before-terminal',
          `${this.harness} reached ${execution.status} before the native interaction: ` +
          bounded(execution)
        )
      }
    }, `thread ${threadId} native interaction`, timeoutMs)
    const execution = latestExecution(thread)
    check.equal('interaction.waiting', execution.status, 'waiting-for-user')
    check.ok('interaction.present',
      Array.isArray(execution.interactions) && execution.interactions.length > 0,
      `waiting execution did not expose interactions: ${bounded(execution)}`
    )
    const interaction = kind
      ? execution.interactions.find(candidate => candidate.kind === kind)
      : execution.interactions[0]
    if (kind) {
      check.equal('interaction.kind',
        interaction?.kind,
        kind,
        `unexpected interaction kind: ${bounded(execution.interactions)}`
      )
    }
    return { thread, execution, interaction }
  }

  /**
   * Responds through the Bart, requiring it to observe the pending public
   * interaction with `openagent_thread_status` before acting on it.
   */
  async respond(input) {
    const respondArguments = {
      threadId: input.threadId,
      interactionId: input.interaction.id,
      actionId: input.actionId,
      ...(input.answers ? { answers: input.answers } : {})
    }
    const operation = await this.bart.askForTool({
      name: 'openagent_thread_respond',
      expectedArguments: respondArguments,
      timeoutMs: input.timeoutMs,
      requiredBefore: {
        name: 'openagent_thread_status',
        expectedArguments: { threadId: input.threadId },
        validate(statusOperation) {
          const observed = statusOperation.result?.thread?.observation?.latestExecution
          check.equal('interaction.observed-waiting',
            observed?.status,
            'waiting-for-user',
            'Bart status did not expose the pending public interaction: ' +
            bounded(statusOperation.result)
          )
          check.ok('interaction.observed-id', observed?.interactions?.some(
            interaction => interaction.id === input.interaction.id
          ))
        }
      },
      directive: orderedCallDirective(
        input.intro || 'Continue the native acceptance case.',
        { name: 'openagent_thread_status', arguments: { threadId: input.threadId } },
        { name: 'openagent_thread_respond', arguments: respondArguments }
      )
    })
    return { operation, respondArguments }
  }

  /** Selects the public response for one native interaction. */
  answerFor(interaction, intent, choice = {}) {
    const action = interaction.actions?.find(candidate => candidate.intent === intent)
    check.ok('interaction.response-action',
      action,
      `interaction has no ${intent} action: ${bounded(interaction)}`
    )
    if (intent !== 'submit') return { actionId: action.id, question: undefined }
    const question = interaction.questions?.[0]
    check.ok('question.present', question, `question interaction has no public question: ${bounded(interaction)}`)
    const index = choice.optionIndex ?? 0
    if (index > 0) {
      check.ok('question.option-count',
        question.options.length > index,
        `question offered ${question.options.length} options, need at least ${index + 1}: ` +
        bounded(question)
      )
    }
    const option = question.options?.[index]
    const customAnswer = choice.customAnswer || `Alpha-${this.token}`
    if (!option) {
      check.equal('question.custom-answer', question.allowOther, true, 'question has neither an option nor a custom answer')
    }
    return {
      actionId: action.id,
      answers: { [question.id]: option?.value || customAnswer },
      expectedLabel: option?.label || customAnswer,
      question
    }
  }

  /**
   * Approves a bounded chain of native permission requests through the Bart.
   * Some CLIs request permission again for a read that verifies an approved
   * write, so a single approval is not a terminality guarantee. Every response
   * still observes and submits the current public interaction through the
   * normal Bart status -> respond sequence.
   */
  async allowPermissionChain(input) {
    const maxPermissions = input.maxPermissions ?? 4
    assert.ok(
      Number.isInteger(maxPermissions) && maxPermissions > 0 && maxPermissions <= 16,
      `maxPermissions must be an integer between 1 and 16: ${maxPermissions}`
    )
    const timeoutMs = input.timeoutMs ?? this.client.timeoutMs
    assert.ok(
      Number.isInteger(timeoutMs) && timeoutMs > 0,
      `permission chain timeout must be a positive integer: ${timeoutMs}`
    )
    const deadline = Date.now() + timeoutMs
    const seen = new Set()
    const interactionIds = []
    let interaction = input.interaction

    const remaining = () => {
      const value = deadline - Date.now()
      if (value <= 0) {
        throw new Error(
          `permission chain timed out after ${timeoutMs}ms; approved=${interactionIds.length}`
        )
      }
      return value
    }

    while (true) {
      check.equal('permission.chain.kind',
        interaction.kind,
        'permission',
        `permission chain received ${interaction.kind}: ${bounded(interaction)}`
      )
      check.ok('permission.chain.fresh-id',
        !seen.has(interaction.id),
        `permission chain repeated a consumed interaction: ${interaction.id}`
      )
      check.ok('permission.chain.limit',
        interactionIds.length < maxPermissions,
        `permission chain exceeded ${maxPermissions} interactions`
      )
      const response = this.answerFor(interaction, 'allow')
      await this.respond({
        threadId: input.threadId,
        interaction,
        actionId: response.actionId,
        timeoutMs: remaining(),
        intro: interactionIds.length === 0
          ? input.intro
          : 'Approve the next native permission required by the same acceptance case.'
      })
      seen.add(interaction.id)
      interactionIds.push(interaction.id)

      const outcome = await this.client.waitForThread(
        input.threadId,
        thread => {
          const execution = latestExecution(thread)
          if (isTerminal(execution)) return { terminal: execution }
          if (execution?.status !== 'waiting-for-user') return undefined
          const pending = (execution.interactions || [])
            .find(candidate => !seen.has(candidate.id))
          return pending ? { interaction: pending } : undefined
        },
        `thread ${input.threadId} permission chain`,
        remaining()
      )
      if (outcome.terminal) {
        check.equal('permission.chain.completed',
          outcome.terminal.status,
          'completed',
          `native work did not complete after permission chain: ${bounded(outcome.terminal)}`
        )
        return { terminal: outcome.terminal, interactionIds }
      }
      interaction = outcome.interaction
    }
  }

  writeProofCommand(path, token) {
    return `printf %s ${shellQuote(token)} > ${shellQuote(path)}`
  }

  async seedSecret(path, secret) {
    await writeFile(path, secret, { encoding: 'utf8', flag: 'wx' })
    return secret
  }

  /**
   * A disposable single-commit repository inside the run root. Worktree cases
   * must never create Git metadata in the checkout under test.
   */
  async createTemporaryGitRepository(name = 'repo') {
    const created = join(this.runRoot, 'git', `${this.token}-${name}`)
    await mkdir(created, { recursive: true })
    // Core canonicalises every cwd it accepts, and the platform temporary root
    // is a symlink on macOS, so the case has to compare canonical paths too.
    const root = await realpath(created)
    await run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })
    await run('git', ['config', 'user.email', 'acceptance@openagent.test'], { cwd: root })
    await run('git', ['config', 'user.name', 'OpenAgent Acceptance'], { cwd: root })
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
    await writeFile(join(root, 'README.md'), `# ${this.token}\n`, 'utf8')
    await run('git', ['add', 'README.md'], { cwd: root })
    await run('git', ['commit', '--quiet', '-m', 'acceptance baseline'], { cwd: root })
    return root
  }

  async cleanup() {
    for (const threadId of this.threads) {
      await this.bart.bestEffortInterrupt(threadId)
    }
  }
}
