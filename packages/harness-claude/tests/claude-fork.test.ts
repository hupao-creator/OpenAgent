import { describe, expect, it } from 'vitest'
import { forkClaudeThread } from '../src/main/fork.js'
import { parseClaudeThreadState } from '../src/shared/state.js'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'
import type { ClaudeThreadSettings } from '../src/shared/settings.js'

describe('Claude native Thread fork derivation', () => {
  it('creates only a one-shot private fork intent and never copies public execution history', () => {
    const source = sourceThread(sourceSessionState())
    const result = forkClaudeThread({
      source,
      request: { checkpointId: 'native-user-message-1' },
      signal: new AbortController().signal
    })

    expect(result).toEqual({
      title: 'Source Thread (Fork)',
      sessionState: {
        version: 1,
        pendingFork: {
          sourceSessionId: 'native-session-source',
          checkpointId: 'native-user-message-1'
        },
        forkHistory: {
          sourceSessionId: 'native-session-source',
          checkpointId: 'native-user-message-1',
          items: [{
            id: 'fork-history:0',
            kind: 'user-message',
            content: 'hello',
            createdAt: 1,
            attachments: [{
              id: 'attachment-1',
              name: 'design.pdf',
              mimeType: 'application/pdf',
              size: 42,
              kind: 'file'
            }],
            checkpointId: 'native-user-message-1'
          }, {
            id: 'fork-history:1',
            kind: 'assistant',
            content: 'answer',
            createdAt: 2,
            status: 'complete'
          }]
        },
        turns: [],
        nativeNotifications: []
      }
    })
    expect(JSON.stringify(result.sessionState)).not.toContain('public-execution-source')
  })

  it('allows latest-session fork without a checkpoint', () => {
    expect(forkClaudeThread({
      source: sourceThread(sourceSessionState()),
      request: {},
      signal: new AbortController().signal
    }).sessionState).toEqual({
      version: 1,
      pendingFork: { sourceSessionId: 'native-session-source' },
      forkHistory: {
        sourceSessionId: 'native-session-source',
        items: [{
          id: 'fork-history:0',
          kind: 'user-message',
          content: 'hello',
          createdAt: 1,
          attachments: [{
            id: 'attachment-1',
            name: 'design.pdf',
            mimeType: 'application/pdf',
            size: 42,
            kind: 'file'
          }],
          checkpointId: 'native-user-message-1'
        }, {
          id: 'fork-history:1',
          kind: 'assistant',
          content: 'answer',
          createdAt: 2,
          status: 'complete'
        }]
      },
      turns: [],
      nativeNotifications: []
    })
  })

  it('strictly rejects unknown fields, foreign checkpoints, and unbound sessions', () => {
    const source = sourceThread(sourceSessionState())
    expect(() => forkClaudeThread({
      source,
      request: { legacySessionId: 'native-session-source' },
      signal: new AbortController().signal
    })).toThrow('未知字段')
    expect(() => forkClaudeThread({
      source,
      request: { checkpointId: 'foreign-checkpoint' },
      signal: new AbortController().signal
    })).toThrow('不属于 source Thread')
    expect(() => forkClaudeThread({
      source: sourceThread({
        version: 1,
        turns: [],
        nativeNotifications: []
      }),
      request: {},
      signal: new AbortController().signal
    })).toThrow('尚未绑定')
  })

  it('honors abort before deriving any result', () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect(() => forkClaudeThread({
      source: sourceThread(sourceSessionState()),
      request: {},
      signal: controller.signal
    })).toThrow('cancelled')
  })

  it('keeps the Core title limit in Unicode code points', () => {
    const source = {
      ...sourceThread(sourceSessionState()),
      title: '界'.repeat(60)
    }
    const title = forkClaudeThread({
      source,
      request: {},
      signal: new AbortController().signal
    }).title
    expect(Array.from(title || '')).toHaveLength(60)
    expect(title).toMatch(/ \(Fork\)$/)
  })

  it('keeps ordered visible provider surface, terminalizes controls, and crops same-turn data', () => {
    const source = sourceThread(structuredSourceSessionState())
    const result = forkClaudeThread({
      source,
      request: { checkpointId: 'checkpoint-before-secret' },
      signal: new AbortController().signal
    })
    const encoded = JSON.stringify(result.sessionState)

    expect(parseClaudeThreadState(result.sessionState).forkHistory?.items.map(
      (item) => item.kind
    )).toEqual([
      'user-message',
      'reasoning',
      'activity',
      'interaction',
      'plan',
      'notice',
      'diff',
      'review',
      'context-compaction',
      'usage',
      'error',
      'assistant'
    ])
    expect(encoded).toContain('visible reasoning')
    expect(encoded).toContain('visible.diff')
    expect(encoded).toContain('visible review')
    expect(encoded).toContain('"status":"cancelled"')
    expect(encoded).not.toContain('secret after checkpoint')
    expect(encoded).not.toContain('public-execution-structured')
    expect(encoded).not.toContain('native-activity-control-id')
    expect(encoded).not.toContain('native-interaction-control-id')
  })
})

function sourceThread(sessionState: JsonValue): AgentThreadRecord<
  'claude',
  ClaudeThreadSettings
> {
  return {
    id: 'source-thread',
    harnessId: 'claude',
    archived: false,
    revision: 4,
    sessionState,
    observation: {
      latestExecution: {
        executionId: 'public-execution-source',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    },
    title: 'Source Thread',
    tags: [],
    cwd: '/workspace',
    settings: { executablePath: 'claude' },
    createdAt: 1,
    updatedAt: 2
  }
}

function sourceSessionState(): JsonValue {
  return {
    version: 1,
    primarySessionId: 'native-session-source',
    turns: [{
      executionId: 'public-execution-source',
      createdAt: 1,
      updatedAt: 2,
      prompts: ['hello'],
      promptAttachments: [[{
        id: 'attachment-1',
        name: 'design.pdf',
        mimeType: 'application/pdf',
        size: 42,
        kind: 'file'
      }]],
      text: 'answer',
      reasoning: '',
      finishedAt: 2,
      status: 'completed',
      plan: [],
      activities: [],
      interactions: [],
      notices: [],
      timeline: [{
        id: 'timeline-user-1',
        kind: 'user-message',
        createdAt: 1,
        promptIndex: 0,
        checkpointId: 'native-user-message-1'
      }, {
        id: 'timeline-assistant-1',
        kind: 'assistant',
        createdAt: 2,
        content: 'answer',
        status: 'complete'
      }]
    }],
    nativeNotifications: []
  }
}

function structuredSourceSessionState(): JsonValue {
  return {
    version: 1,
    primarySessionId: 'native-session-source',
    turns: [{
      executionId: 'public-execution-structured',
      createdAt: 1,
      updatedAt: 30,
      prompts: ['visible prompt', 'secret after checkpoint prompt'],
      promptAttachments: [[], []],
      text: 'secret after checkpoint answer',
      reasoning: 'visible reasoningsecret after checkpoint reasoning',
      finishedAt: 30,
      status: 'completed',
      error: 'secret after checkpoint error aggregate',
      plan: [{ step: 'secret after checkpoint plan', status: 'completed' }],
      activities: [{
        id: 'native-activity-control-id',
        kind: 'command',
        label: 'secret after checkpoint activity aggregate',
        status: 'completed'
      }],
      interactions: [{
        id: 'native-interaction-control-id',
        kind: 'permission',
        title: 'secret after checkpoint interaction aggregate',
        status: 'resolved'
      }],
      notices: [{
        id: 'notice-after',
        level: 'warning',
        message: 'secret after checkpoint notice aggregate'
      }],
      timeline: [{
        id: 'structured-0',
        kind: 'user-message',
        createdAt: 1,
        promptIndex: 0,
        checkpointId: 'checkpoint-before-secret'
      }, {
        id: 'structured-1',
        kind: 'reasoning',
        createdAt: 2,
        content: 'visible reasoning'
      }, {
        id: 'structured-2',
        kind: 'activity',
        createdAt: 3,
        activity: {
          id: 'native-activity-control-id',
          kind: 'command',
          label: 'Run visible command',
          status: 'running',
          detail: 'visible command output'
        }
      }, {
        id: 'structured-3',
        kind: 'interaction',
        createdAt: 4,
        interaction: {
          id: 'native-interaction-control-id',
          kind: 'permission',
          title: 'Approve visible command',
          description: 'visible interaction presentation',
          status: 'pending'
        }
      }, {
        id: 'structured-4',
        kind: 'plan',
        createdAt: 5,
        plan: [{ step: 'visible plan', status: 'inProgress' }],
        explanation: 'visible explanation'
      }, {
        id: 'structured-5',
        kind: 'notice',
        createdAt: 6,
        notice: { id: 'visible-notice', level: 'info', message: 'visible notice' }
      }, {
        id: 'structured-7',
        kind: 'diff',
        createdAt: 8,
        content: 'visible.diff'
      }, {
        id: 'structured-8',
        kind: 'review',
        createdAt: 9,
        content: 'visible review'
      }, {
        id: 'structured-9',
        kind: 'context-compaction',
        createdAt: 10
      }, {
        id: 'structured-10',
        kind: 'usage',
        createdAt: 11,
        usage: { inputTokens: 10, outputTokens: 2 }
      }, {
        id: 'structured-11',
        kind: 'error',
        createdAt: 12,
        message: 'visible error'
      }, {
        id: 'structured-12',
        kind: 'assistant',
        createdAt: 13,
        content: 'visible answer',
        status: 'complete'
      }, {
        id: 'structured-13',
        kind: 'user-message',
        createdAt: 14,
        promptIndex: 1,
        checkpointId: 'secret-after-checkpoint'
      }, {
        id: 'structured-14',
        kind: 'reasoning',
        createdAt: 15,
        content: 'secret after checkpoint reasoning'
      }, {
        id: 'structured-15',
        kind: 'diff',
        createdAt: 16,
        content: 'secret after checkpoint diff'
      }, {
        id: 'structured-16',
        kind: 'assistant',
        createdAt: 17,
        content: 'secret after checkpoint answer',
        status: 'complete'
      }]
    }],
    nativeNotifications: []
  }
}
