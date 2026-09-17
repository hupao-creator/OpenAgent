import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { ClaudeToolBridge } from '../src/main/tool-bridge.js'

it('exposes discriminated creation tools without a top-level union that Claude Code drops', async () => {
  const variants = ['first', 'second'].map(id => ({ type: 'object',
    properties: { harnessId: { const: id }, options: { type: 'object', required: [id] } },
    required: ['harnessId', 'options'], additionalProperties: false }))
  const bridge = await ClaudeToolBridge.create([{ name: 'create_thread', description: 'Create a Thread',
    inputSchema: { type: 'object', oneOf: variants }, execute: async () => ({}) }])
  try {
    const config = bridge.claudeConfiguration() as { mcpServers: { openagent: { env: { OPENAGENT_TOOL_DEFINITIONS_PATH: string } } } }
    const [tool] = JSON.parse(await readFile(config.mcpServers.openagent.env.OPENAGENT_TOOL_DEFINITIONS_PATH, 'utf8'))
    expect(tool.inputSchema.oneOf).toBeUndefined()
    expect(tool.inputSchema).toMatchObject({ type: 'object',
      if: { properties: { harnessId: { const: 'first' } }, required: ['harnessId'] },
      // The assertion compares a JSON Schema conditional.
      // oxlint-disable-next-line unicorn/no-thenable
      then: variants[0], else: variants[1] })
  } finally { await bridge.dispose() }
})
