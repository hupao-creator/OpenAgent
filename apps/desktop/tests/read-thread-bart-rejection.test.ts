import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ErasedHarnessMainPluginModule } from '@openagent/contracts'
import { bindMainHarnessComposition } from '../src/main/harness-composition'
import { OpenAgentService } from '../src/main/openagent-service'
import { createChannelHandlers } from '../src/main/command-router'
import { AttachmentRepository } from '../src/main/services/attachment-repository'
import { ThreadStateStore } from '../src/main/services/thread-state-store'
import { WorktreeManager } from '../src/main/services/worktree-manager'
import { ScheduledDispatchStore } from '../src/main/scheduled-dispatch'
import { HARNESS_IDS, harnessDescriptors, type HarnessId } from '../src/shared/harnesses'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'
import { createOpenAgentState, readBartThread } from '../src/shared/openagent-state'
import { testSessionState } from '@openagent/test-kit'

const directories: string[] = []
const services: OpenAgentService[] = []
const stores: ThreadStateStore[] = []

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.shutdown()))
  await Promise.allSettled(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

/**
 * Thread Read targets ordinary Agent Threads, never the Bart Thread. A Bart id
 * must be rejected at the `readThread` entry instead of silently forwarding to
 * the Bart Handle (which carries the app-level mutation tools and
 * `thread_read` itself).
 */
describe('Thread Read rejects the Bart Thread', () => {
  it('rejects a Bart id on the Service entry without forwarding to its Handle', async () => {
    const fixture = await serviceFixture()
    await fixture.service.initialize()
    const bartThreadId = readBartThread(fixture.store.read()).id

    await expect(fixture.service.readThread({
      threadId: bartThreadId,
      question: 'summarize yourself'
    })).rejects.toThrow(
      `Bart Thread 不是 Thread Read 的对象: ${bartThreadId}（read 只接受普通 Agent Thread）`
    )
    // The fake Handle answers every read. A resolved value here would mean the
    // removed forwarding branch is back.
    expect(fixture.forwardedReads).toEqual([])
  })

  it('rejects a Bart id over the IPC thread:read channel', async () => {
    const fixture = await serviceFixture()
    await fixture.service.initialize()
    const bartThreadId = readBartThread(fixture.store.read()).id
    const handlers = createChannelHandlers(fixture.service, {
      attachmentStore: fixture.attachments,
      openExternal: async () => undefined
    })

    await expect(handlers['thread:read']({
      threadId: bartThreadId,
      question: 'what have you done?'
    })).rejects.toThrow(
      `Bart Thread 不是 Thread Read 的对象: ${bartThreadId}（read 只接受普通 Agent Thread）`
    )
    expect(fixture.forwardedReads).toEqual([])
  })
})

interface ServiceFixture {
  readonly service: OpenAgentService
  readonly store: ThreadStateStore
  readonly attachments: AttachmentRepository
  readonly forwardedReads: string[]
}

async function serviceFixture(): Promise<ServiceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openagent-read-thread-bart-')))
  directories.push(root)
  const bartCwd = join(root, 'bart')
  const defaultCwd = join(root, 'default')
  const temporaryWorkspaceRoot = join(root, 'temporary')
  await Promise.all([
    mkdir(bartCwd, { recursive: true }),
    mkdir(defaultCwd, { recursive: true })
  ])

  const forwardedReads: string[] = []
  const store = new ThreadStateStore(root)
  stores.push(store)
  const settings = createDefaultOpenAgentSettings()
  await store.save(createOpenAgentState({
    bartThreadId: 'bart-thread-read-rejection',
    hostHarnessId: 'codex',
    bartThreadSettings: { model: 'bart-model' },
    bartCwd,
    createdAt: 1,
    selectedThreadId: 'bart-thread-read-rejection',
    settings: {
      ...settings,
      bart: { ...settings.bart, targetHarnessIds: ['codex'] }
    }
  }))

  const attachments = new AttachmentRepository(join(bartCwd, '.openagent', 'attachments'))
  const service = new OpenAgentService(
    store,
    bindMainHarnessComposition(HARNESS_IDS.map(id => fixtureModule(id, forwardedReads))),
    new WorktreeManager(),
    attachments,
    new ScheduledDispatchStore(root),
    { defaultCwd, bartCwd, temporaryWorkspaceRoot }
  )
  services.push(service)
  return { service, store, attachments, forwardedReads }
}

/** Minimal Main Plugin bundle: only the surface Core initialization touches. */
function fixtureModule(
  id: HarnessId,
  forwardedReads: string[]
): ErasedHarnessMainPluginModule {
  return {
    id,
    descriptor: harnessDescriptors[id],
    defaultHarnessSettings: {},
    createMainPlugin: () => ({
      sessionState: testSessionState,
      availability: { probe: async () => ({ available: true }) },
      detectInstallation: async () => ({ status: 'installed' as const, executablePath: `${id}-test` }),
      openThread: async () => ({
        send: async () => { throw new Error('unused fixture send') },
        interrupt: async () => undefined,
        respond: async () => undefined,
        read: async (question: string) => {
          forwardedReads.push(question)
          return `forwarded:${question}`
        },
        dispose: async () => undefined
      }),
      prompt: { complete: async () => { throw new Error('unused fixture prompt') } },
      settings: {
        normalizeHarnessSettings: value => structuredClone(value),
        describe: async () => ({ type: 'object', properties: {}, additionalProperties: false }),
        defaultThreadSettings: () => ({}),
        hasThreadContent: () => false,
        resolveThreadSettings: async () => ({}),
        applyThreadSettingsUpdate: async () => ({}),
        promptSettings: () => ({})
      },
      settingsPresentation: { load: async () => ({}) }
    })
  } as ErasedHarnessMainPluginModule
}
