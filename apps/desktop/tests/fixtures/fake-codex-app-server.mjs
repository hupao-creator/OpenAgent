#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

if (['debug models', 'debug models --bundled'].includes(process.argv.slice(2).join(' '))) {
  process.stdout.write(JSON.stringify({ models: [{ slug: 'fake-model' }] }))
  process.exit(0)
}
if (process.argv.slice(2).join(' ') === '--version') {
  process.stdout.write('fake-codex 0.150.1\n')
  process.exit(0)
}

let buffer = ''
let dynamicTool
let backgroundTerminalRunning = false
let secondBackgroundTerminalRunning = false
let backgroundCompletionScheduled = false
let backgroundStaleListsRemaining = 0
let backgroundListFailuresRemaining = Number(process.env.FAKE_CODEX_BACKGROUND_LIST_FAILURES || 0)
let backgroundListRequestCount = 0
let turnStartCount = 0
let metadataThreadStartCount = 0
let metadataTurnStartCount = 0
let dynamicToolCallCount = 0
let lastDynamicToolArguments
let lastDynamicToolName
let hubSkillEnabled = true
let hubPluginInstalled = false
let hubAppEnabled = false
let hubAccountType = 'chatgpt'
const batchResponses = new Set()
const processScopedThreads = process.env.FAKE_CODEX_PROCESS_SCOPED_THREADS === '1'
const loadedThreadIds = new Set()
let pendingSteerResponses = Number(process.env.FAKE_CODEX_STEER_PENDING || 0)

function configuredDynamicToolArguments() {
  if (!process.env.FAKE_CODEX_DYNAMIC_TOOL_ARGUMENTS) return { prompt: 'Run tests' }
  try {
    const configured = JSON.parse(process.env.FAKE_CODEX_DYNAMIC_TOOL_ARGUMENTS)
    const executeAfterMs = Number(process.env.FAKE_CODEX_DYNAMIC_TOOL_EXECUTE_AFTER_MS)
    return Number.isFinite(executeAfterMs) && executeAfterMs >= 0
      ? { ...configured, executeAt: new Date(Date.now() + executeAfterMs).toISOString() }
      : configured
  } catch {
    return { prompt: 'Run tests' }
  }
}

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\n')
}
if (process.env.FAKE_CODEX_PID_FILE) {
  appendFileSync(process.env.FAKE_CODEX_PID_FILE, `${process.pid}\n`)
}
if (process.env.FAKE_CODEX_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {})
}
if (process.env.FAKE_CODEX_CHILD_IGNORE_SIGTERM === '1') {
  const child = spawn(process.execPath, [
    '-e',
    "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.FAKE_CODEX_CHILD_READY_FILE,'ready');setInterval(()=>{},1_000)"
  ], { stdio: 'ignore' })
  if (process.env.FAKE_CODEX_CHILD_PID_FILE && child.pid) {
    appendFileSync(process.env.FAKE_CODEX_CHILD_PID_FILE, `${child.pid}\n`)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    handle(JSON.parse(line))
  }
})

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value)).join('\n') + '\n')
}

function log(value) {
  if (process.env.FAKE_CODEX_LOG) {
    const entry = processScopedThreads
      ? { ...value, fakeProcessId: process.pid }
      : value
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n')
  }
}

function rejectUnknownProcessThread(message) {
  const threadId = message.params?.threadId
  if (!processScopedThreads || !threadId || loadedThreadIds.has(threadId)) return false
  send({
    id: message.id,
    error: {
      code: -32000,
      message: `thread not found in app-server process ${process.pid}: ${threadId}`
    }
  })
  return true
}

function sendBackgroundCompletion() {
  backgroundTerminalRunning = false
  if (process.env.FAKE_CODEX_BACKGROUND_STALE_AFTER_COMPLETION === '1') {
    backgroundStaleListsRemaining = 1
  }
  send({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'background-command-1',
        type: 'commandExecution',
        command: 'sleep 90',
        aggregatedOutput: 'background complete',
        status: process.env.FAKE_CODEX_BACKGROUND_COMPLETION_STATUS || 'completed'
      }
    }
  })
}

function approvalSettings(params) {
  if (process.env.FAKE_CODEX_IGNORE_REVIEWER === '1') return {}
  return {
    approvalsReviewer: params.approvalsReviewer || 'user',
    approvalPolicy: params.approvalPolicy || 'on-request',
    sandbox: { type: params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' }
  }
}

function handle(message) {
  log(message)
  if (message.method === 'initialize') {
    const respond = () => send({ id: message.id, result: { userAgent: process.env.FAKE_CODEX_USER_AGENT || 'fake-codex/0.153.4' } })
    const delay = Number(process.env.FAKE_CODEX_INITIALIZE_DELAY_MS || 0)
    if (delay > 0) setTimeout(respond, delay)
    else respond()
    return
  }
  if (message.method === 'initialized') {
    send({ method: 'app/list/updated', params: { data: [{ id: 'not-for-renderer' }] } })
    return
  }
  if (message.method === 'config/read') {
    send({
      id: message.id,
      result: {
        config: {
          // Codex CLI 0.153.4 reports approvals_reviewer only when the home
          // configures it; an unconfigured home reports null, which
          // FAKE_CODEX_NO_REVIEWER models. The default here is the configured
          // shape #136's approve-for-me default needs in order to resolve.
          ...(process.env.FAKE_CODEX_NO_REVIEWER === '1' ? {} : { approvals_reviewer: 'user' }),
          mcp_servers: { context7: { enabled: true }, playwright: { enabled: true } },
          plugins: {
            browser: { mcp_servers: { browser_tools: { enabled: true } } }
          },
          apps: { calendar: { enabled: hubAppEnabled } },
          ...(process.env.FAKE_CODEX_CONFIG_WRITABLE_ROOT
            ? {
                sandbox_workspace_write: {
                  writable_roots: [process.env.FAKE_CODEX_CONFIG_WRITABLE_ROOT]
                }
              }
            : {})
        },
        origins: {},
        layers: null
      }
    })
    return
  }
  if (message.method === 'skills/list') {
    send({
      id: message.id,
      result: {
        data: [{
          cwd: message.params?.cwds?.[0] || process.cwd(),
          skills: [
            { name: 'openai-docs', path: '/skills/openai-docs/SKILL.md', enabled: hubSkillEnabled },
            { name: 'browser', path: '/skills/browser/SKILL.md', enabled: true }
          ],
          errors: []
        }]
      }
    })
    return
  }
  if (message.method === 'skills/config/write') {
    hubSkillEnabled = message.params?.enabled === true
    send({ id: message.id, result: { effectiveEnabled: hubSkillEnabled } })
    return
  }
  if (message.method === 'plugin/list') {
    send({
      id: message.id,
      result: {
        marketplaces: [{
          name: 'openai-bundled',
          path: null,
          interface: null,
          plugins: [{
            id: 'browser@openai-bundled',
            name: 'browser',
            version: '1.0.0',
            localVersion: hubPluginInstalled ? '1.0.0' : null,
            installed: hubPluginInstalled,
            enabled: hubPluginInstalled,
            availability: 'AVAILABLE'
          }]
        }],
        marketplaceLoadErrors: [],
        featuredPluginIds: ['browser@openai-bundled']
      }
    })
    return
  }
  if (message.method === 'plugin/installed') {
    const computerUseAvailable = process.env.FAKE_CODEX_COMPUTER_USE_AVAILABLE !== '0'
    send({
      id: message.id,
      result: {
        marketplaces: [{
          name: 'openai-bundled',
          plugins: [
            ...(computerUseAvailable
              ? [{
                  id: 'computer-use@openai-bundled',
                  name: 'computer-use',
                  installed: true,
                  enabled: true,
                  availability: 'AVAILABLE'
                }]
              : []),
            ...(hubPluginInstalled
              ? [{
                  id: 'browser@openai-bundled',
                  name: 'browser',
                  version: '1.0.0',
                  installed: true,
                  enabled: true,
                  availability: 'AVAILABLE'
                }]
              : [])
          ]
        }],
        marketplaceLoadErrors: []
      }
    })
    return
  }
  if (message.method === 'plugin/install') {
    hubPluginInstalled = true
    send({
      id: message.id,
      result: { authPolicy: 'ON_USE', appsNeedingAuth: [] }
    })
    return
  }
  if (message.method === 'plugin/uninstall') {
    hubPluginInstalled = false
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'app/list') {
    if (rejectUnknownProcessThread(message)) return
    send({
      id: message.id,
      result: {
        data: [{
          id: 'calendar',
          name: 'Calendar',
          description: 'Fake calendar connector',
          logoUrl: null,
          logoUrlDark: null,
          iconAssets: null,
          iconDarkAssets: null,
          distributionChannel: 'fake',
          branding: null,
          appMetadata: null,
          labels: null,
          installUrl: null,
          isAccessible: true,
          isEnabled: hubAppEnabled,
          pluginDisplayNames: []
        }],
        nextCursor: null
      }
    })
    return
  }
  if (message.method === 'mcpServerStatus/list') {
    if (rejectUnknownProcessThread(message)) return
    send({
      id: message.id,
      result: {
        data: [{
          name: 'context7',
          runtimeStatus: null,
          pluginId: null,
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'notLoggedIn'
        }],
        nextCursor: null
      }
    })
    return
  }
  if (message.method === 'mcpServer/oauth/login') {
    send({
      id: message.id,
      result: { authorizationUrl: 'https://example.test/fake-mcp-oauth' }
    })
    return
  }
  if (message.method === 'config/mcpServer/reload') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'hooks/list') {
    send({ id: message.id, result: { data: [] } })
    return
  }
  if (message.method === 'permissionProfile/list') {
    send({ id: message.id, result: { data: [], nextCursor: null } })
    return
  }
  if (message.method === 'model/list') {
    if (process.env.FAKE_CODEX_MODEL_LIST_ERROR === '1') {
      send({ id: message.id, error: { code: -32000, message: 'model catalog unavailable' } })
      return
    }
    const efforts = (process.env.FAKE_CODEX_MODEL_EFFORTS || 'low,medium,high')
      .split(',')
      .map((effort) => effort.trim())
      .filter(Boolean)
    let configuredModels
    try {
      configuredModels = process.env.FAKE_CODEX_MODELS_JSON
        ? JSON.parse(process.env.FAKE_CODEX_MODELS_JSON)
        : undefined
    } catch {
      configuredModels = undefined
    }
    send({
      id: message.id,
      result: {
        data: Array.isArray(configuredModels) ? configuredModels : [{
          id: 'fake-model-id',
          model: process.env.FAKE_CODEX_MODEL || 'gpt-test',
          displayName: 'Fake Codex',
          description: 'Fake model for Codex app-server tests.',
          supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
          defaultReasoningEffort: efforts[0] || '',
          serviceTiers: [{ id: 'default', name: 'Default', description: 'Default tier' }],
          defaultServiceTier: 'default',
          inputModalities: ['text'],
          isDefault: true
        }]
      }
    })
    return
  }
  if (message.method === 'account/rateLimits/read') {
    send({ id: message.id, result: { rateLimits: {} } })
    return
  }
  if (message.method === 'account/read') {
    send({
      id: message.id,
      result: {
        account: hubAccountType === 'chatgpt'
          ? { type: 'chatgpt', email: 'fake@example.test', planType: 'plus' }
          : { type: 'apiKey' },
        requiresOpenaiAuth: true
      }
    })
    return
  }
  if (message.method === 'account/usage/read') {
    send({
      id: message.id,
      result: {
        summary: { totalInputTokens: 120, totalOutputTokens: 30 },
        dailyUsageBuckets: []
      }
    })
    return
  }
  if (message.method === 'account/workspaceMessages/read') {
    send({
      id: message.id,
      result: { featureEnabled: true, messages: [] }
    })
    return
  }
  if (message.method === 'account/login/start') {
    hubAccountType = message.params?.type === 'apiKey' ? 'apiKey' : 'chatgpt'
    send({
      id: message.id,
      result: message.params?.type === 'chatgptDeviceCode'
        ? {
            type: 'chatgptDeviceCode',
            loginId: 'fake-device-login',
            verificationUrl: 'https://example.test/fake-device-login',
            userCode: 'FAKE-CODE'
          }
        : message.params?.type === 'chatgpt'
          ? {
              type: 'chatgpt',
              loginId: 'fake-browser-login',
              authUrl: 'https://example.test/fake-browser-login'
            }
          : { type: 'apiKey' }
    })
    return
  }
  if (message.method === 'account/logout') {
    hubAccountType = 'apiKey'
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'config/value/write') {
    if (message.params?.keyPath === 'apps.calendar.enabled') {
      hubAppEnabled = message.params?.value === true
    }
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'configRequirements/read') {
    send({ id: message.id, result: { requirements: process.env.FAKE_CODEX_DENY_AUTO_REVIEW === '1' ? { allowedApprovalsReviewers: ['user'] } : null } })
    return
  }
  if (message.method === 'thread/start') {
    const dynamicTools = message.params?.dynamicTools || []
    dynamicTool = process.env.FAKE_CODEX_DYNAMIC_TOOL_NAME
      ? dynamicTools.find((tool) => tool.name === process.env.FAKE_CODEX_DYNAMIC_TOOL_NAME)
      : dynamicTools[0]
    const threadId =
      process.env.FAKE_CODEX_INTERRUPT_FLOW === '1' && message.params?.ephemeral === true
        ? `thread-metadata-${++metadataThreadStartCount}`
        : processScopedThreads
          ? `thread-${process.pid}-1`
          : 'thread-1'
    loadedThreadIds.add(threadId)
    send({
      id: message.id,
      result: process.env.FAKE_CODEX_MISSING_THREAD_ID === 'start'
        ? { thread: {} }
        : {
            thread: { id: threadId },
            ...approvalSettings(message.params),
            ...(process.env.FAKE_CODEX_RAW_USAGE === '1'
              ? { model: 'gpt-5.4-initial' }
              : {})
          }
    })
    return
  }
  if (message.method === 'thread/resume') {
    const threadId = message.params?.threadId || 'thread-1'
    loadedThreadIds.add(threadId)
    send({
      id: message.id,
      result: process.env.FAKE_CODEX_MISSING_THREAD_ID === 'resume'
        ? { thread: {} }
        : { thread: { id: threadId }, ...approvalSettings(message.params) }
    })
    return
  }
  if (message.method === 'thread/fork') {
    const threadId = processScopedThreads
      ? `thread-${process.pid}-fork-1`
      : 'thread-fork-1'
    loadedThreadIds.add(threadId)
    send({
      id: message.id,
      result: process.env.FAKE_CODEX_MISSING_THREAD_ID === 'fork'
        ? { thread: {} }
        : { thread: { id: threadId }, ...approvalSettings(message.params) }
    })
    return
  }
  if (message.method === 'thread/backgroundTerminals/list') {
    backgroundListRequestCount += 1
    if (backgroundListFailuresRemaining > 0) {
      backgroundListFailuresRemaining -= 1
      send({ id: message.id, error: { code: -32000, message: 'temporary list failure' } })
      return
    }
    const data = [
      ...(backgroundTerminalRunning || backgroundStaleListsRemaining > 0
        ? [{
          itemId: 'background-command-1',
          processId: 'process-42',
          command: 'sleep 90',
          cwd: process.cwd(),
          osPid: null,
          cpuPercent: null,
          rssKb: null
        }]
        : []),
      ...(secondBackgroundTerminalRunning
        ? [{
            itemId: 'background-command-2',
            processId: 'process-43',
            command: 'sleep 120',
            cwd: process.cwd(),
            osPid: null,
            cpuPercent: null,
            rssKb: null
          }]
        : [])
    ]
    if (!backgroundTerminalRunning && backgroundStaleListsRemaining > 0) {
      backgroundStaleListsRemaining -= 1
    }
    if (
      backgroundTerminalRunning &&
      backgroundListRequestCount === Number(process.env.FAKE_CODEX_BACKGROUND_DELAY_LIST_NUMBER) &&
      process.env.FAKE_CODEX_BACKGROUND_COMPLETE_DURING_DELAYED_LIST === '1'
    ) {
      setTimeout(sendBackgroundCompletion, 10)
      setTimeout(() => {
        send({ id: message.id, result: { data, nextCursor: null } })
      }, 40)
      return
    }
    if (
      backgroundTerminalRunning &&
      process.env.FAKE_CODEX_BACKGROUND_COMPLETES_DURING_LIST === '1'
    ) {
      sendBackgroundCompletion()
    }
    send({
      id: message.id,
      result: {
        data,
        nextCursor: null
      }
    })
    if (
      backgroundTerminalRunning &&
      process.env.FAKE_CODEX_BACKGROUND_STAYS_RUNNING !== '1' &&
      !backgroundCompletionScheduled
    ) {
      backgroundCompletionScheduled = true
      setTimeout(sendBackgroundCompletion, 10)
    }
    return
  }
  if (message.method === 'thread/backgroundTerminals/terminate') {
    const terminated = backgroundTerminalRunning
    backgroundTerminalRunning = false
    send({ id: message.id, result: { terminated } })
    return
  }
  if (message.method === 'thread/backgroundTerminals/clean') {
    backgroundTerminalRunning = false
    secondBackgroundTerminalRunning = false
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'turn/interrupt') {
    if (process.env.FAKE_CODEX_INTERRUPT_ERROR === '1') {
      send({ id: message.id, error: { code: -32000, message: 'interrupt rejected' } })
      return
    }
    send({ id: message.id, result: {} })
    if (process.env.FAKE_CODEX_INTERRUPT_COMPLETES === '1') {
      const threadId = message.params?.threadId || 'thread-1'
      const turnId = message.params?.turnId || 'turn-1'
      setTimeout(() => {
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'interrupted' } }
        })
      }, 5)
    }
    if (process.env.FAKE_CODEX_INTERRUPT_FLOW === '1') {
      const threadId = message.params?.threadId || 'thread-1'
      const turnId = message.params?.turnId || 'turn-1'
      setTimeout(() => {
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              id: 'interrupt-command-1',
              type: 'commandExecution',
              command: 'sleep 120',
              cwd: process.cwd(),
              aggregatedOutput: 'interrupted',
              status: 'cancelled'
            }
          }
        })
        send({
          method: 'thread/status/changed',
          params: { threadId, status: { type: 'idle' } }
        })
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'interrupted' } }
        })
      }, 5)
    }
    return
  }
  if (message.method === 'turn/start') {
    const threadId = message.params?.threadId || 'thread-1'
    const metadataRequest = Array.isArray(message.params?.input) &&
      message.params.input.some((item) =>
        item?.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.includes('<thread_metadata_context>')
      )
    if (metadataRequest) {
      const turnId = `turn-metadata-${++metadataTurnStartCount}`
      const item = {
        id: `message-metadata-${metadataTurnStartCount}`,
        type: 'agentMessage',
        text: JSON.stringify({
          title: process.env.FAKE_CODEX_INTERRUPT_FLOW === '1'
            ? 'Codex interrupt'
            : 'Codex task',
          tags: [{
            name: 'Codex',
            description: 'Work handled by the Codex Harness.'
          }]
        })
      }
      send({ id: message.id, result: { turn: { id: turnId } } })
      setTimeout(() => {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: item.id, delta: item.text }
        })
        send({ method: 'item/completed', params: { threadId, turnId, item } })
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed', items: [item] } }
        })
      }, 5)
      return
    }
    turnStartCount += 1
    const turnId = `turn-${turnStartCount}`
    send({ id: message.id, result: { turn: { id: turnId } } })
    if (process.env.FAKE_CODEX_RAW_USAGE === '1') {
      const item = {
        id: `message-raw-usage-${turnStartCount}`,
        type: 'agentMessage',
        text: 'RAW_USAGE_COMPLETE'
      }
      setTimeout(() => {
        // One stdout write deliberately exercises decoding several complete
        // JSONL frames from the same native chunk.
        sendBatch([
          {
            method: 'thread/settings/updated',
            params: {
              threadId,
              threadSettings: { model: 'gpt-5.4-settings' }
            }
          },
          {
            method: 'model/rerouted',
            params: {
              threadId,
              turnId,
              fromModel: 'gpt-5.4-settings',
              toModel: 'gpt-5.4-rerouted'
            }
          },
          {
            method: 'rawResponse/completed',
            params: {
              threadId,
              turnId,
              responseId: 'response-raw-usage-1',
              usage: {
                inputTokens: 100,
                cachedInputTokens: 40,
                cacheWriteInputTokens: 10,
                outputTokens: 20,
                reasoningOutputTokens: 6
              }
            }
          },
          {
            method: 'rawResponse/completed',
            params: {
              threadId,
              turnId,
              responseId: 'response-raw-usage-1',
              usage: {
                inputTokens: 100,
                cachedInputTokens: 40,
                cacheWriteInputTokens: 10,
                outputTokens: 20,
                reasoningOutputTokens: 6
              }
            }
          },
          {
            method: 'rawResponse/completed',
            params: {
              threadId,
              turnId,
              responseId: 'response-raw-usage-2',
              usage: {
                inputTokens: 50,
                cachedInputTokens: 5,
                cacheWriteInputTokens: 0,
                outputTokens: 7,
                reasoningOutputTokens: 1
              }
            }
          },
          {
            method: 'thread/tokenUsage/updated',
            params: {
              threadId,
              turnId,
              tokenUsage: {
                last: {
                  inputTokens: 9_999,
                  cachedInputTokens: 8_888,
                  outputTokens: 7_777,
                  reasoningOutputTokens: 6_666
                },
                modelContextWindow: 200_000
              }
            }
          },
          {
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: item.id, delta: item.text }
          },
          { method: 'item/completed', params: { threadId, turnId, item } },
          {
            method: 'turn/completed',
            params: {
              threadId,
              turn: { id: turnId, status: 'completed', items: [item] }
            }
          }
        ])
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_INTERRUPT_FLOW === '1') {
      if (turnStartCount === 1) {
        setTimeout(() => {
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId,
              item: {
                id: 'interrupt-command-1',
                type: 'commandExecution',
                command: 'sleep 120',
                cwd: process.cwd(),
                processId: 'interrupt-process-1',
                status: 'inProgress'
              }
            }
          })
          send({
            method: 'thread/status/changed',
            params: { threadId, status: { type: 'active', activeFlags: [] } }
          })
        }, 5)
      } else {
        setTimeout(() => {
          const item = {
            id: `message-interrupt-recovery-${turnStartCount}`,
            type: 'agentMessage',
            text: 'RECOVERED_AFTER_INTERRUPT'
          }
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId,
              turnId,
              itemId: item.id,
              delta: item.text
            }
          })
          send({
            method: 'item/completed',
            params: { threadId, turnId, item }
          })
          send({
            method: 'turn/completed',
            params: {
              threadId,
              turn: { id: turnId, status: 'completed', items: [item] }
            }
          })
        }, 5)
      }
      return
    }
    if (
      process.env.FAKE_CODEX_BACKGROUND_ABA_USER_TURN === '1' &&
      turnStartCount === 3
    ) {
      setTimeout(() => {
        send({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } }
        })
      }, 5)
      setTimeout(() => {
        const item = {
          id: 'message-after-background-wake',
          type: 'agentMessage',
          text: 'USER_AFTER_BACKGROUND_WAKE'
        }
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId, itemId: item.id, delta: item.text }
        })
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item } })
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'completed', items: [item] }
          }
        })
      }, 80)
      return
    }
    if (
      process.env.FAKE_CODEX_BACKGROUND_WAKE_RESPONSE === '1' &&
      turnStartCount > (process.env.FAKE_CODEX_BACKGROUND_ACTIVE_STEER_REJECT === '1' ? 2 : 1)
    ) {
      setTimeout(() => {
        const item = {
          id: `message-background-wake-${turnStartCount}`,
          type: 'agentMessage',
          text: 'BACKGROUND_WOKE_CODEX'
        }
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId,
            itemId: item.id,
            delta: item.text
          }
        })
        send({
          method: 'item/completed',
          params: { threadId: 'thread-1', turnId, item }
        })
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'completed', items: [item] }
          }
        })
      }, 5)
      return
    }
    if (
      (process.env.FAKE_CODEX_BACKGROUND_ACTIVE_STEER === '1' ||
        process.env.FAKE_CODEX_BACKGROUND_ACTIVE_STEER_REJECT === '1') &&
      turnStartCount === 2
    ) {
      setTimeout(() => {
        send({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } }
        })
      }, 5)
      setTimeout(sendBackgroundCompletion, 20)
      if (process.env.FAKE_CODEX_BACKGROUND_ACTIVE_STEER_REJECT === '1') {
        setTimeout(() => {
          const item = {
            id: 'message-active-finished',
            type: 'agentMessage',
            text: 'ACTIVE_FINISHED_CODEX'
          }
          send({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId, itemId: item.id, delta: item.text }
          })
          send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item } })
          send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: turnId, status: 'completed', items: [item] }
            }
          })
        }, 80)
      }
      return
    }
    if (process.env.FAKE_CODEX_BACKGROUND_TERMINAL === '1') {
      const secondTurn =
        process.env.FAKE_CODEX_BACKGROUND_SECOND_TURN === '1' && turnStartCount === 2
      if (secondTurn) secondBackgroundTerminalRunning = true
      else backgroundTerminalRunning = true
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId,
            item: {
              id: secondTurn ? 'background-command-2' : 'background-command-1',
              type: 'commandExecution',
              command: secondTurn ? 'sleep 120' : 'sleep 90',
              cwd: process.cwd(),
              processId: secondTurn ? 'process-43' : 'process-42',
              status: 'inProgress'
            }
          }
        })
        send({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1', status: { type: 'idle' } }
        })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_STATUS_STUCK === '1') {
      // 报 active 之后永不收敛：模拟 app-server 在回合途中失联/被关闭。
      setTimeout(() => {
        send({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_STATUS_FLOW === '1') {
      setTimeout(() => {
        send({
          method: 'thread/status/changed',
          params: {
            threadId: 'thread-1',
            status: { type: 'active', activeFlags: ['waitingOnUserInput'] }
          }
        })
        send({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1', status: { type: 'idle' } }
        })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_FINAL_ITEMS_ONLY === '1') {
      const items = [
        { id: 'final-only-1', type: 'agentMessage', text: 'First final-only answer.' },
        { id: 'final-only-2', type: 'agentMessage', text: 'Second final-only answer.' }
      ]
      setTimeout(() => {
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items } }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_COMPLETION_FALLBACKS === '1') {
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId,
            item: {
              id: 'fallback-command-1',
              type: 'commandExecution',
              command: 'printf fallback',
              cwd: process.cwd(),
              status: 'inProgress'
            }
          }
        })
        send({
          method: 'item/commandExecution/outputDelta',
          params: {
            threadId: 'thread-1',
            turnId,
            itemId: 'fallback-command-1',
            delta: 'streamed command output'
          }
        })
        send({
          method: 'item/reasoning/summaryTextDelta',
          params: {
            threadId: 'thread-1',
            turnId,
            itemId: 'fallback-reasoning-1',
            delta: 'Partial'
          }
        })
        send({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId,
            item: {
              id: 'fallback-reasoning-1',
              type: 'reasoning',
              summary: ['Partial suffix']
            }
          }
        })
        send({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId,
            item: {
              id: 'fallback-command-1',
              type: 'commandExecution',
              command: 'printf fallback',
              aggregatedOutput: '',
              status: 'completed'
            }
          }
        })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }
        })
      }, 5)
      return
    }
    if (message.params?.threadId === 'thread-fork-1') {
      setTimeout(() => {
        const splitFirst = process.env.FAKE_CODEX_SPLIT_MESSAGE_NEWLINES === '1'
          ? 'First update.\n'
          : 'First update.'
        const splitSecond = process.env.FAKE_CODEX_SPLIT_MESSAGE_NEWLINES === '1'
          ? '\nSecond update.'
          : 'Second update.'
        const items = process.env.FAKE_CODEX_SPLIT_MESSAGES === '1'
          ? [
              { id: 'message-fork-part-1', type: 'agentMessage', text: splitFirst },
              { id: 'message-fork-part-2', type: 'agentMessage', text: splitSecond }
            ]
          : [{ id: 'message-fork', type: 'agentMessage', text: 'Fork read complete.' }]
        for (const item of items) {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-fork-1',
              turnId,
              itemId: item.id,
              delta: item.text
            }
          })
          send({
            method: 'item/completed',
            params: { threadId: 'thread-fork-1', turnId, item }
          })
        }
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-fork-1',
            turn: { id: turnId, status: 'completed', items }
          }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_FINAL_MESSAGE_REVISION === '1') {
      setTimeout(() => {
        const draft = {
          id: 'message-revised',
          type: 'agentMessage',
          text: '{"status":"draft"}'
        }
        const final = { ...draft, text: '{"status":"final"}' }
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId, itemId: draft.id, delta: draft.text }
        })
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item: draft } })
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'completed', items: [final] }
          }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_SPLIT_MESSAGES === '1') {
      setTimeout(() => {
        const splitFirst = process.env.FAKE_CODEX_SPLIT_MESSAGE_NEWLINES === '1'
          ? 'First update.\n'
          : 'First update.'
        const splitSecond = process.env.FAKE_CODEX_SPLIT_MESSAGE_NEWLINES === '1'
          ? '\nSecond update.'
          : 'Second update.'
        const items = [
          { id: 'message-part-1', type: 'agentMessage', text: splitFirst },
          { id: 'message-part-2', type: 'agentMessage', text: splitSecond }
        ]
        for (const item of items) {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-1',
              turnId,
              itemId: item.id,
              delta: item.text
            }
          })
          send({
            method: 'item/completed',
            params: { threadId: 'thread-1', turnId, item }
          })
        }
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items } }
        })
      }, 5)
      return
    }
    const dynamicToolMaxCalls = Number(process.env.FAKE_CODEX_DYNAMIC_TOOL_MAX_CALLS || Infinity)
    if (dynamicTool && dynamicToolCallCount >= dynamicToolMaxCalls) {
      const item = {
        id: `message-after-dynamic-tool-${turnStartCount}`,
        type: 'agentMessage',
        text: 'No further tool action.'
      }
      setTimeout(() => {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: item.id, delta: item.text }
        })
        send({ method: 'item/completed', params: { threadId, turnId, item } })
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed', items: [item] } }
        })
      }, 5)
      return
    }
    if (dynamicTool) {
      dynamicToolCallCount += 1
      const dynamicToolArguments = configuredDynamicToolArguments()
      lastDynamicToolArguments = dynamicToolArguments
      lastDynamicToolName = dynamicTool.name
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'dynamic-tool-1',
              type: 'dynamicToolCall',
              tool: lastDynamicToolName,
              arguments: dynamicToolArguments,
              status: 'inProgress'
            }
          }
        })
        send({
          id: 'wire-dynamic-tool',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'dynamic-tool-1',
            namespace: null,
            tool: lastDynamicToolName,
            arguments: dynamicToolArguments
          }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_BATCH === '1') {
      setTimeout(() => {
        for (const [id, itemId, method] of [
          ['wire-batch-1', 'command-batch-1', 'item/commandExecution/requestApproval'],
          ['wire-batch-2', 'file-batch-2', 'item/fileChange/requestApproval']
        ]) {
          send({
            id,
            method,
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId,
              startedAtMs: Date.now(),
              reason: 'Review requested workspace change',
              ...(method === 'item/commandExecution/requestApproval'
                ? { kind: 'command', environmentId: null, command: 'cat README.md' }
                : { grantRoot: process.cwd() })
            }
          })
        }
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_LARGE_OUTPUT === '1') {
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'large-command-1',
              type: 'commandExecution',
              command: 'generate large output',
              cwd: process.cwd(),
              status: 'inProgress'
            }
          }
        })
        send({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'large-command-1',
              type: 'commandExecution',
              command: 'generate large output',
              aggregatedOutput: 'output-start\n' + 'x'.repeat(40_000) + '\noutput-tail',
              status: 'completed'
            }
          }
        })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_NONBLOCKING_INPUT === '1' || process.env.FAKE_CODEX_AUTO_RESOLUTION_MS) {
      setTimeout(() => {
        send({
          id: 'wire-nonblocking-input',
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'question-1',
            ...(process.env.FAKE_CODEX_NATIVE_INTERACTION_ID
              ? { interactionId: process.env.FAKE_CODEX_NATIVE_INTERACTION_ID }
              : {}),
            isBlocking: false,
            autoResolutionMs: process.env.FAKE_CODEX_AUTO_RESOLUTION_MS
              ? Number(process.env.FAKE_CODEX_AUTO_RESOLUTION_MS)
              : null,
            questions: [{
              id: process.env.FAKE_CODEX_NATIVE_QUESTION_ID || 'scope',
              header: 'Scope',
              question: 'Which scope?',
              isOther: false,
              isSecret: false,
              options: process.env.FAKE_CODEX_NONBLOCKING_INPUT_OPTIONS
                ? JSON.parse(process.env.FAKE_CODEX_NONBLOCKING_INPUT_OPTIONS)
                : [{ label: 'Workspace', description: 'Current workspace' }]
            }]
          }
        })
      }, 5)
      return
    }
    if (process.env.FAKE_CODEX_ELICITATION_MODE) {
      const mode = process.env.FAKE_CODEX_ELICITATION_MODE
      setTimeout(() => {
        send({
          id: 'wire-elicitation-1',
          method: 'mcpServer/elicitation/request',
          params: mode === 'url'
            ? {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'fake-mcp',
                mode,
                message: 'Open the external form',
                url: 'https://example.test/form',
                elicitationId: 'external-form-1',
                _meta: { requestContext: 'url-request-1' }
              }
            : {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'fake-mcp',
                mode,
                message: 'Provide deployment details',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    environment: { type: 'string' },
                    replicas: { type: 'integer' }
                  },
                  required: ['environment']
                },
                _meta: { formContext: 'deployment-request-1' }
              }
        })
      }, 5)
      return
    }
    setTimeout(() => {
      send({
        id: 'wire-approval-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'command-1',
          kind: 'command',
          environmentId: null,
          startedAtMs: Date.now(),
          command: 'npm test',
          reason: 'Run verification'
        }
      })
    }, 5)
    return
  }
  if (message.method === 'turn/steer') {
    if (process.env.FAKE_CODEX_BACKGROUND_ACTIVE_STEER_REJECT === '1') {
      send({ id: message.id, error: { code: -32000, message: 'active turn rejected steer' } })
      return
    }
    if (pendingSteerResponses > 0) {
      pendingSteerResponses -= 1
      send({ id: message.id, error: { code: -32000, message: 'no active turn to steer yet' } })
    } else {
      send({ id: message.id, result: {} })
      if (process.env.FAKE_CODEX_BACKGROUND_ACTIVE_STEER === '1') {
        const item = {
          id: 'message-background-steer',
          type: 'agentMessage',
          text: 'BACKGROUND_STEERED_CODEX'
        }
        setTimeout(() => {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-1',
              turnId: message.params?.expectedTurnId || 'turn-2',
              itemId: item.id,
              delta: item.text
            }
          })
          send({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: message.params?.expectedTurnId || 'turn-2',
              item
            }
          })
          send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: {
                id: message.params?.expectedTurnId || 'turn-2',
                status: 'completed',
                items: [item]
              }
            }
          })
        }, 5)
      }
    }
    return
  }
  if (message.id === 'wire-dynamic-tool' && message.result) {
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'dynamic-tool-1',
          type: 'dynamicToolCall',
          tool: lastDynamicToolName,
          arguments: lastDynamicToolArguments ?? configuredDynamicToolArguments(),
          status: message.result.success ? 'completed' : 'failed',
          success: message.result.success,
          contentItems: message.result.contentItems
        }
      }
    })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Tool complete.' } })
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    return
  }
  if ((message.id === 'wire-batch-1' || message.id === 'wire-batch-2') && message.result) {
    batchResponses.add(message.id)
    if (batchResponses.size === 2) {
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    }
    return
  }
  if (message.id === 'wire-nonblocking-input' && message.result) {
    send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
    })
    return
  }
  if (message.id === 'wire-elicitation-1' && message.result) {
    send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
    })
    return
  }
  if (message.id === 'wire-approval-1' && message.result) {
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'wire-approval-1' } })
    send({
      method: 'turn/plan/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', explanation: 'Verify first', plan: [{ step: 'Run tests', status: 'inProgress' }] }
    })
    send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', delta: 'Checking.' } })
    send({ method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId: 'turn-1', diff: 'diff --git a/a b/a' } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'All good.' } })
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'message-1', type: 'agentMessage', text: 'All good.' }
      }
    })
    send({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 }, modelContextWindow: 128000 } }
    })
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    return
  }
  if (message.method === 'thread/shellCommand') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.id !== undefined && message.method) send({ id: message.id, result: {} })
}
