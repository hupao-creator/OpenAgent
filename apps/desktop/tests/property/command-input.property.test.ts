import fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import {
  createChannelHandlers,
  type CommandChannel,
  type CommandRuntimeServices,
  type CommandService
} from '../../src/main/command-router'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budget = process.env.FC_EXPLORE ? 120_000 : 30_000
const samples = { normal: 100, explore: 1000 }

// The controlled root of the staging stub. It answers true for one relative
// path that the real repository's `relative()`-based check would reject, so the
// router's own absolute-path guard is the deciding condition for that part
// rather than being shadowed by the managed half of the rule.
const isManagedPath = (path: string): boolean =>
  path.startsWith('/managed/') || path === 'relative.png'

// Documented rule for a `local-file` part: legal only when its path is both
// absolute and inside the store's controlled root.
const acceptedFilePath = (path: string): boolean => path.startsWith('/') && isManagedPath(path)

/** Test-owned native boundary: every service/staging/external call is observed. */
function boundary() {
  const service = {
    submitBartMessage: vi.fn(async () => undefined),
    clearBartSession: vi.fn(async () => undefined),
    cancelBartTask: vi.fn(async () => undefined),
    clearAllHistory: vi.fn(async () => undefined),
    followUpThread: vi.fn(async () => undefined),
    interruptThread: vi.fn(async () => undefined),
    respondToThreadInteraction: vi.fn(async () => undefined),
    readThread: vi.fn(async () => undefined),
    forkThread: vi.fn(async () => undefined),
    updateThreadSettings: vi.fn(async () => undefined),
    updateAppSettings: vi.fn(async () => undefined),
    detectHarnessInstallations: vi.fn(async () => []),
    listKnownDirectories: vi.fn(async () => []),
    installHarness: vi.fn(async () => undefined),
    loadHarnessSettingsPresentation: vi.fn(async () => undefined),
    invokeHarnessExtension: vi.fn(async () => undefined),
    setThreadArchived: vi.fn(async () => undefined),
    setReportArchived: vi.fn(async () => undefined),
    loadRendererState: vi.fn(async () => undefined),
    updateUiState: vi.fn(async () => undefined)
  }
  const attachmentStore = {
    stage: vi.fn(async (imports: unknown) => imports),
    isManagedPath: vi.fn(isManagedPath)
  }
  const openExternal = vi.fn(async () => undefined)
  const handlers = createChannelHandlers(
    service as unknown as CommandService,
    {
      attachmentStore: attachmentStore as unknown as CommandRuntimeServices['attachmentStore'],
      openExternal
    }
  )
  const untouched = () => {
    for (const spy of [
      ...Object.values(service),
      attachmentStore.stage,
      openExternal
    ]) {
      expect(spy).not.toHaveBeenCalled()
    }
  }
  return { service, attachmentStore, openExternal, handlers, untouched }
}

const text = (value: string) => ({ kind: 'text', text: value })
const managedFile = (path: string) => ({
  kind: 'local-file',
  file: { id: 'file-1', path, name: 'a.png', mimeType: 'image/png', size: 10 }
})

// `content` marks a part that satisfies the non-empty rule: any non-text part
// counts as content, so an image- or mention-only submission stays legal.
type PartCase = { value: unknown; accepted: boolean; content: boolean }

// Each part carries its own verdict, so the request oracle below is stated in
// terms of the documented rules rather than of the parser's internals.
const partCase: fc.Arbitrary<PartCase> = fc.oneof(
  fc.constantFrom('hello', 'x', '   ', '', '\t\n').map(value => ({
    value: text(value), accepted: true, content: value.trim().length > 0
  })),
  fc.constantFrom('/managed/a.png', '/outside/b.png', 'relative.png').map(path => ({
    value: managedFile(path), accepted: acceptedFilePath(path), content: true
  })),
  fc.constantFrom('/managed/a.png', '/outside/b.png', 'relative.png').map(path => ({
    value: {
      kind: 'image',
      file: { id: 'file-2', path, name: 'b.png', mimeType: 'image/png', size: 4 },
      detail: 'high'
    },
    accepted: acceptedFilePath(path),
    content: true
  })),
  fc.constantFrom('/abs/doc.md', 'rel/doc.md').map(path => ({
    value: { kind: 'mention', name: 'doc', path }, accepted: path.startsWith('/'), content: true
  })),
  // Unknown variant, unknown field, and non-object parts are rejected by the
  // closed public schema, not by a downstream service.
  fc.constantFrom('bogus', 7, null).map(kind => ({
    value: { kind, text: 'x' }, accepted: false, content: false
  })),
  fc.constant({ value: { ...text('x'), forged: true }, accepted: false, content: false }),
  fc.constantFrom(null, 3, 'text', []).map(value => ({ value, accepted: false, content: false }))
)

// Both sides of the public part bound: 128 is legal, 129 is not.
const maxParts: PartCase[] = Array.from({ length: 128 }, () => ({
  value: text('x'), accepted: true, content: true
}))

const oversizeParts: PartCase[] = Array.from({ length: 129 }, () => ({
  value: text('x'), accepted: true, content: true
}))

it('Bart submit accepts exactly the documented input shapes', async () => {
  await checkAsync('Bart submit accepts exactly the documented input shapes', fc.asyncProperty(
    fc.record({
      parts: fc.oneof(
        fc.array(partCase, { maxLength: 4 }),
        fc.constant(maxParts),
        fc.constant(oversizeParts)
      ),
      // `' Workspace '` is legal only because the schema trims it, so the
      // normalization is observable rather than trivially satisfied.
      directoryTag: fc.constantFrom(undefined, 'Workspace', ' Workspace ', '\tWorkspace\n', '  ', ''),
      forged: fc.constantFrom(undefined, 'provider', 'nativeFeedback')
    }),
    async ({ parts, directoryTag, forged }) => {
      const store = boundary()
      const raw: Record<string, unknown> = { input: { parts: parts.map(part => part.value) } }
      if (directoryTag !== undefined) raw.directoryTag = directoryTag
      if (forged !== undefined) raw[forged] = 'codex'
      const accepted = forged === undefined &&
        (directoryTag === undefined || directoryTag.trim().length > 0) &&
        parts.length >= 1 && parts.length <= 128 &&
        parts.every(part => part.accepted) && parts.some(part => part.content)
      if (!accepted) {
        await expect(store.handlers['bart:submit'](raw)).rejects.toThrow()
        store.untouched()
        return
      }
      await store.handlers['bart:submit'](raw)
      expect(store.service.submitBartMessage).toHaveBeenCalledWith({
        input: { parts: parts.map(part => part.value) },
        ...(directoryTag === undefined ? {} : { directoryTag: directoryTag.trim() })
      })
      expect(store.service.submitBartMessage).toHaveBeenCalledTimes(1)
    }
  ), 'one generated Bart request; a refused request must reach no service, staging or external call', budget, samples)
}, timeout)

const attachmentPaths = ['/tmp/a.txt', '/var/b.md', 'relative/c.txt', './d.txt']
const attachmentNames = ['a.txt', '', null, undefined] as const

type ImportCase = { value: unknown; accepted: boolean; expected: unknown }

// Each import case is atomic: fast-check may pick a different case, but must
// never drill into one and leave its verdict contradicting its own payload.
const importCases: ImportCase[] = [
  ...attachmentPaths.flatMap(path => attachmentNames.map(displayName => ({
    value: { source: 'path', path, displayName },
    accepted: path.startsWith('/'),
    expected: { source: 'path', path, displayName: displayName || '附件' }
  }))),
  // 20 MB exactly is the documented maximum for a path-less paste.
  ...[0, 8, 1024, 20 * 1024 * 1024].map(size => {
    const bytes = new ArrayBuffer(size)
    return {
      value: { source: 'bytes', bytes, displayName: 'a.txt' },
      accepted: true,
      expected: { source: 'bytes', bytes, displayName: 'a.txt' }
    }
  }),
  {
    value: { source: 'bytes', bytes: new ArrayBuffer(20 * 1024 * 1024 + 1), displayName: 'big' },
    accepted: false,
    expected: undefined
  },
  { value: { source: 'url', path: '/tmp/a.txt' }, accepted: false, expected: undefined },
  { value: { source: 'bytes', displayName: 'x' }, accepted: false, expected: undefined },
  {
    value: { source: 'path', path: '/tmp/a.txt', displayName: 'x', forged: 1 },
    accepted: false,
    expected: undefined
  },
  ...[null, 42, 'path', []].map(value => ({ value, accepted: false, expected: undefined }))
]

const importCase: fc.Arbitrary<ImportCase> = fc.constantFrom(...importCases)

const validImport = {
  value: { source: 'path', path: '/tmp/a.txt', displayName: 'a.txt' },
  accepted: true,
  expected: { source: 'path', path: '/tmp/a.txt', displayName: 'a.txt' }
}

it('Attachment staging accepts only absolute paths and bounded byte sources', async () => {
  await checkAsync('Attachment staging accepts only absolute paths and bounded byte sources', fc.asyncProperty(
    fc.oneof(
      fc.constant(null),
      fc.constant([]),
      fc.array(importCase, { minLength: 1, maxLength: 3 }),
      // Both sides of the import-count bound: 20 entries are staged, 21 refuse.
      fc.constant(Array.from({ length: 20 }, () => validImport)),
      fc.constant(Array.from({ length: 21 }, () => validImport))
    ),
    async imports => {
      const store = boundary()
      // A missing list stages the empty one; otherwise every entry must be legal
      // and the public import bound must hold.
      const list = imports ?? []
      const raw = list.map(item => item.value)
      const accepted = list.length <= 20 && list.every(item => item.accepted)
      if (!accepted) {
        await expect(store.handlers['bart:stage-attachments'](raw)).rejects.toThrow()
        store.untouched()
        return
      }
      await expect(store.handlers['bart:stage-attachments'](raw))
        .resolves.toEqual(list.map(item => item.expected))
      expect(store.attachmentStore.stage).toHaveBeenCalledTimes(1)
      expect(store.attachmentStore.stage).toHaveBeenCalledWith(list.map(item => item.expected))
      expect(store.openExternal).not.toHaveBeenCalled()
    }
  ), 'one generated attachment import list; a refused import must reach no staging or service call', budget, samples)
}, timeout)

const externalUrl = fc.oneof(
  fc.webUrl(),
  fc.constantFrom(
    'https://example.com/a', 'http://example.com', 'https://user:pw@example.com/x?q=1#f',
    'HTTPS://Example.COM/Path', 'file:///etc/passwd', 'javascript:alert(1)',
    'ftp://example.com', 'data:text/html,x', 'not a url', '', 'https://'
  ),
  fc.string({ maxLength: 12 }),
  fc.constantFrom(7, null, undefined, {}, ['https://example.com'])
)

it('Opening an external link forwards only a normalized HTTP(S) URL', async () => {
  await checkAsync('Opening an external link forwards only a normalized HTTP(S) URL', fc.asyncProperty(
    externalUrl,
    async raw => {
      const store = boundary()
      let normalized: string | undefined
      if (typeof raw === 'string') {
        try {
          const url = new URL(raw)
          if (url.protocol === 'https:' || url.protocol === 'http:') normalized = url.toString()
        } catch { /* not a URL: the boundary must refuse it */ }
      }
      if (normalized === undefined) {
        await expect(store.handlers['shell:open-external'](raw)).rejects.toThrow()
        store.untouched()
        return
      }
      await store.handlers['shell:open-external'](raw)
      expect(store.openExternal).toHaveBeenCalledTimes(1)
      expect(store.openExternal).toHaveBeenCalledWith(normalized)
    }
  ), 'one generated link; a refused link must never reach the external opener', budget, samples)
}, timeout)

/** Valid control payloads: each must be accepted without its forged sibling. */
const structuredCommands: readonly {
  channel: CommandChannel
  base: Record<string, unknown>
  reaches: keyof CommandService
}[] = [
  {
    channel: 'bart:submit',
    base: { input: { parts: [text('hi')] } },
    reaches: 'submitBartMessage'
  },
  {
    channel: 'thread:follow-up',
    base: { threadId: 'thread-1', input: { parts: [text('hi')] } },
    reaches: 'followUpThread'
  },
  {
    channel: 'thread:read',
    base: { threadId: 'thread-1', question: 'why' },
    reaches: 'readThread'
  },
  {
    channel: 'thread:fork',
    base: { threadId: 'thread-1', request: { from: 'here' } },
    reaches: 'forkThread'
  },
  {
    channel: 'thread:interaction-respond',
    base: { threadId: 'thread-1', interactionId: 'interaction-1', actionId: 'action-1' },
    reaches: 'respondToThreadInteraction'
  },
  {
    channel: 'thread:update-settings',
    base: { harnessId: 'codex', threadId: 'thread-1', change: {} },
    reaches: 'updateThreadSettings'
  },
  {
    channel: 'harness:extension',
    base: { harnessId: 'codex', method: 'status', payload: {} },
    reaches: 'invokeHarnessExtension'
  },
  {
    channel: 'harness:settings-presentation',
    base: { scope: 'global', harnessId: 'codex' },
    reaches: 'loadHarnessSettingsPresentation'
  },
  {
    channel: 'state:update-ui',
    base: { selectedThreadId: 'thread-1' },
    reaches: 'updateUiState'
  },
  {
    channel: 'app:update-settings',
    base: {
      locale: 'zh-CN',
      appearance: 'dark',
      bart: {
        hostHarnessPreference: 'codex',
        targetHarnessIds: [],
        routingGuidance: null
      },
      harnesses: {}
    },
    reaches: 'updateAppSettings'
  }
]

it('Every structured command channel refuses an unsupported field without reaching the service', async () => {
  await checkAsync('Every structured command channel refuses an unsupported field without reaching the service', fc.asyncProperty(
    fc.constantFrom(...structuredCommands),
    fc.constantFrom('__forged', 'provider', 'nativeFeedback'),
    fc.constantFrom(true, 'codex', 1, null, { nested: true }, []),
    async (command, forged, value) => {
      const store = boundary()
      // Control: the same payload without the forged sibling is accepted, so the
      // rejection below is attributable to the unsupported field alone.
      await store.handlers[command.channel]({ ...command.base })
      expect(store.service[command.reaches]).toHaveBeenCalledTimes(1)
      const control = boundary()
      await expect(control.handlers[command.channel]({
        ...command.base, [forged]: value
      })).rejects.toThrow(/未支持字段/)
      control.untouched()
    }
  ), 'the same generated structured command on two boundaries: a control call without the forged sibling, then the request carrying it; only the forged request must fail, before any service call', budget, samples)
}, timeout)
