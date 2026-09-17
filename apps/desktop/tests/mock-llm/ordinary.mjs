import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export function installOrdinaryScript(llm) {
  const calls = new Map()
  llm.expect(request => request.toolNames.some(name => name.endsWith('acceptance_receipt')), request => {
    const tool = request.tools.find(candidate => candidate.name.endsWith('acceptance_receipt'))
    assert.equal(request.tools.length, 1, 'Exclusive receipt session exposed other native tools')
    const text = [request.systemMessage, ...request.messages.map(message => message.content)].join('\n')
    const args = Object.fromEntries([
      ['instruction', 'instruction receipt is'], ['thread', 'Thread receipt is'],
      ['seed', 'seed receipt'], ['telemetry', 'telemetry receipt is'],
      ['evaluation', 'evaluation receipt is'], ['send', 'current send receipt is']
    ].map(([key, label]) => {
      const matches = [...text.matchAll(new RegExp(`${label} ([a-f0-9]+)\\.`, 'g'))]
      assert.ok(matches.length, `Missing ${label}`)
      return [key, matches.at(-1)[1]]
    }))
    const key = `${args.instruction}:${args.send}`
    const prior = calls.get(key)
    if (prior) {
      const result = request.messages.findLast(message => message.role === 'tool' && message.toolCallId === prior)
      assert.ok(result, 'CLI repeated a receipt request without its tool result')
      const receipt = completionReceipt(result.content)
      assert.ok(receipt, 'Receipt tool result omitted its completion receipt')
      return { text: receipt }
    }
    if (tool.parameters.required.includes('historyReceipt')) {
      assert.ok(text.includes('very first acceptance_receipt call'), 'Updated history instruction is absent from the request')
      // Search only data actually transmitted by the CLI, including native
      // transcript replay when replacing a session-bound tool schema.
      const receipt = completionReceipt(request.messages.map(message => message.content).join('\n'))
      assert.ok(receipt, 'First completion receipt is absent from native conversation history')
      args.historyReceipt = receipt
    }
    assert.deepEqual([...tool.parameters.required].sort(), Object.keys(args).sort(), 'Receipt schema changed unexpectedly')
    const id = `call_${randomUUID()}`
    calls.set(key, id)
    return { tools: [{ id, name: tool.name, args }] }
  })
}

function completionReceipt(text) {
  return text.match(/\\*"completionReceipt\\*"\s*:\s*\\*"([a-f0-9]+)\\*"/)?.[1]
}
