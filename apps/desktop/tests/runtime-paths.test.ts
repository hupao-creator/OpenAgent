import { access, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveDevUserDataPath,
  resolveHeadlessUserDataPath,
  resolveRuntimePaths
} from '../src/main/runtime-paths'
import { AttachmentRepository } from '../src/main/services/attachment-repository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('runtime path isolation', () => {
  it('uses stable disjoint GUI and headless roots by default', () => {
    const homePath = '/Users/example'
    const gui = resolveRuntimePaths({
      headless: false,
      homePath,
      userDataPath: '/Library/Application Support/Agent Workspace'
    })
    const headlessUserData = resolveHeadlessUserDataPath(gui.userDataPath)
    const headless = resolveRuntimePaths({
      headless: true,
      homePath,
      userDataPath: headlessUserData
    })

    expect(gui.userDataPath).toBe('/Library/Application Support/Agent Workspace')
    expect(headless.userDataPath).toBe(
      '/Library/Application Support/Agent Workspace Headless'
    )
    expect(gui.openAgentHome).toBe('/Users/example/.OpenAgent')
    expect(headless.openAgentHome).toBe('/Users/example/.OpenAgent-headless')
    expect(headless.bartCwd).not.toBe(gui.bartCwd)
    expect(headless.attachmentRoot).not.toBe(gui.attachmentRoot)
    expect(headless.temporaryWorkspaceRoot).not.toBe(gui.temporaryWorkspaceRoot)
  })

  it('honors process-private absolute acceptance roots and rejects relative ones', () => {
    const paths = resolveRuntimePaths({
      headless: true,
      homePath: '/Users/example',
      userDataPath: resolveHeadlessUserDataPath('/ignored', '/tmp/worker/user-data'),
      headlessOpenAgentHome: '/tmp/worker/openagent-home'
    })

    expect(paths.userDataPath).toBe('/tmp/worker/user-data')
    expect(paths.openAgentHome).toBe('/tmp/worker/openagent-home')
    expect(() => resolveHeadlessUserDataPath('/default', 'relative/user-data'))
      .toThrow('OPENAGENT_HEADLESS_USER_DATA must be an absolute path')
    expect(() => resolveRuntimePaths({
      headless: true,
      homePath: '/Users/example',
      userDataPath: '/tmp/user-data',
      headlessOpenAgentHome: 'relative/openagent-home'
    })).toThrow('OPENAGENT_HEADLESS_HOME must be an absolute path')
  })

  it('lets a second dev instance relocate its Electron profile', () => {
    expect(resolveDevUserDataPath('/Library/Application Support/Agent Workspace'))
      .toBe('/Library/Application Support/Agent Workspace Electron Dev')
    expect(resolveDevUserDataPath('/ignored', '/tmp/worker/user-data'))
      .toBe('/tmp/worker/user-data')
    expect(resolveDevUserDataPath('/ignored', '  '))
      .toBe('/ignored Electron Dev')
    expect(() => resolveDevUserDataPath('/default', 'relative/user-data'))
      .toThrow('OPENAGENT_DEV_USER_DATA must be an absolute path')
  })

  it('moves only the attachment root for an isolated dev instance', () => {
    const shared = resolveRuntimePaths({
      headless: false,
      homePath: '/Users/example',
      userDataPath: '/tmp/user-data'
    })
    expect(shared.attachmentRoot).toBe(
      '/Users/example/.OpenAgent/bart-workspace/.openagent/attachments'
    )

    const isolated = resolveRuntimePaths({
      headless: false,
      homePath: '/Users/example',
      userDataPath: '/tmp/user-data',
      devAttachmentRoot: '/tmp/dev-main/attachments'
    })
    expect(isolated.attachmentRoot).toBe('/tmp/dev-main/attachments')
    // The home stays shared: generated no-CWD threads are only recognizable as
    // temporary while they live under the root the classifier knows.
    expect(isolated.openAgentHome).toBe(shared.openAgentHome)
    expect(isolated.temporaryWorkspaceRoot).toBe(shared.temporaryWorkspaceRoot)

    expect(() => resolveRuntimePaths({
      headless: false,
      homePath: '/Users/example',
      userDataPath: '/tmp/user-data',
      devAttachmentRoot: 'relative/attachments'
    })).toThrow('OPENAGENT_DEV_ATTACHMENT_ROOT must be an absolute path')
  })

  it('prevents headless orphan collection from touching GUI attachments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-runtime-paths-'))
    temporaryDirectories.push(directory)
    const gui = resolveRuntimePaths({
      headless: false,
      homePath: directory,
      userDataPath: join(directory, 'gui-user-data')
    })
    const headless = resolveRuntimePaths({
      headless: true,
      homePath: directory,
      userDataPath: join(directory, 'headless-user-data'),
      headlessOpenAgentHome: join(directory, 'acceptance', 'openagent-home')
    })
    const guiStore = new AttachmentRepository(gui.attachmentRoot)
    const headlessStore = new AttachmentRepository(headless.attachmentRoot)
    const [guiAttachment] = await guiStore.stage([{
      source: 'bytes',
      bytes: Uint8Array.from([1]).buffer,
      displayName: 'gui.bin'
    }])
    const [headlessAttachment] = await headlessStore.stage([{
      source: 'bytes',
      bytes: Uint8Array.from([2]).buffer,
      displayName: 'headless.bin'
    }])
    const old = new Date(Date.now() - 10_000)
    await Promise.all([
      utimes(dirname(guiAttachment.path), old, old),
      utimes(dirname(headlessAttachment.path), old, old)
    ])

    await headlessStore.collectOrphans(1_000)

    await expect(access(headlessAttachment.path)).rejects.toThrow()
    await expect(access(guiAttachment.path)).resolves.toBeUndefined()
  })
})
