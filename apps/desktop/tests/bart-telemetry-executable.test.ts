import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BartTelemetryLedgerCapability, BartTelemetryLedgerSample } from '@openagent/contracts'
import { createCodexMainPlugin } from '../../../packages/harness-codex/src/main'
import { createClaudeMainPlugin } from '../../../packages/harness-claude/src/main'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe.each(['codex', 'claude'] as const)('%s telemetry effective executable', harness => {
  it('reads the auto-detected native account because Harness settings never pin the binary', async () => {
    const directory = await mkdtemp(join(tmpdir(), `openagent-${harness}-telemetry-path-`))
    directories.push(directory)
    const topLevelCli = await createTelemetryCli(directory, 'top-level-cli', 'top-level-account', 83)
    const environment = async () => ({
      // Keep the Claude fixture on native get_usage, independent of user settings.
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CONFIG_DIR: directory
    })
    const context = {
      dataRoot: directory,
      temporaryWorkspaceRoot: directory,
      environment,
      // A Harness default is a bare command name the host resolves through PATH,
      // where the fixture stands in; a settings key can never pin an absolute
      // path because the Host owns CLI discovery (A1).
      resolveExecutable: async (_cwd: string, configuredPath?: string) =>
        !configuredPath || !configuredPath.includes('/') ? topLevelCli : configuredPath
    }
    const plugin = harness === 'codex'
      ? createCodexMainPlugin(context)
      : createClaudeMainPlugin(context)
    const samples: BartTelemetryLedgerSample[] = []
    const telemetryLedger: BartTelemetryLedgerCapability = {
      record: async sample => { samples.push(sample) },
      read: () => ({ windows: [] })
    }
    try {
      const content = await plugin.bartContextEntries?.telemetry?.({
        settings: { threadSettings: {} },
        cwd: directory,
        telemetryLedger,
        signal: AbortSignal.timeout(5_000)
      })

      // These facts originate in the launched CLI subprocess, so the wrong
      // executable cannot pass by merely forwarding the desired path argument.
      expect(JSON.parse(content || '{}')).toMatchObject({
        namespace: harness,
        availability: 'available',
        plan: 'top-level-account',
        windows: [expect.objectContaining({
          usedPercent: 83,
          remainingPercent: 17
        })]
      })
      expect(samples).toEqual([expect.objectContaining({
        type: 'window-reading',
        windows: [expect.objectContaining({ usedPercent: 83 })]
      })])
    } finally {
      await plugin.dispose?.()
    }
  })
})

it('keeps Codex API-key authentication outside native subscription quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-codex-api-key-'))
  directories.push(directory)
  const executable = await createTelemetryCli(directory, 'api-key-cli', 'must-not-use', 83, 'apiKey')
  const plugin = createCodexMainPlugin({ dataRoot: directory, temporaryWorkspaceRoot: directory,
    environment: async () => ({}), resolveExecutable: async () => executable })
  try {
    const content = await plugin.bartContextEntries?.telemetry?.({ settings: { threadSettings: {} }, cwd: directory,
      signal: AbortSignal.timeout(5_000), telemetryLedger: { record: async () => { throw new Error('Must not record native quota') }, read: () => ({ windows: [] }) } })
    expect(JSON.parse(content || '{}')).toMatchObject({ availability: 'unknown' })
    expect(content).not.toContain('must-not-use')
  } finally { await plugin.dispose?.() }
})

/** An actual executable implementing both native read-only quota protocols. */
async function createTelemetryCli(directory: string, name: string, plan: string, usedPercent: number, accountType = 'chatgpt'): Promise<string> {
  const executable = join(directory, `${name}.cjs`)
  await writeFile(executable, `#!${process.execPath}
const readline = require('node:readline')
const plan = ${JSON.stringify(plan)}
const usedPercent = ${usedPercent}
const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10))
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line)
  if (value.method && value.id !== undefined) {
    const result = value.method === 'account/rateLimits/read' ? {
      rateLimits: {
        limitId: 'codex', planType: plan,
        primary: { usedPercent, windowDurationMins: 300, resetsAt: 1900000000 }
      }
    } : value.method === 'account/read' ? { account: { type: ${JSON.stringify(accountType)} }, requiresOpenaiAuth: true } : {}
    send({ id: value.id, result })
  } else if (value.type === 'control_request') {
    const response = value.request.subtype === 'get_usage' ? {
      subscription_type: plan, rate_limits_available: true,
      rate_limits: { five_hour: { utilization: usedPercent, resets_at: '2030-03-17T17:46:40.000Z' } }
    } : { models: [] }
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: value.request_id, response
    } })
  }
})
`, { mode: 0o755 })
  return executable
}
