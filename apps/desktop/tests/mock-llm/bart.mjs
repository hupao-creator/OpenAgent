import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

/** Interpret only the acceptance fixture grammar; never read product state or expected results. */
export function installBartScript(llm) {
  const turns = new Map()
  llm.expect(request => request.toolNames.some(name => name.endsWith('openagent_thread_list')), request => {
    const directive = request.lastMessage
    if (directive.includes('Terminal history verification VERIFY_')) {
      const batch = request.messages.findLastIndex(message => message.role === 'user' &&
        message.content.includes('Start one multi-Thread terminal-history acceptance batch.'))
      assert.ok(batch >= 0, 'Terminal recall omitted the prior batch from HTTP history')
      const events = request.messages.slice(batch + 1).flatMap(message => {
        const match = message.content.match(/OpenAgent Agent Thread terminal event:\n(\{[^\n]+\})/)
        return match ? [JSON.parse(match[1])] : []
      })
      assert.equal(events.length, 3, 'Expected three HTTP terminal history events in injection order')
      return { text: events.map(event => {
        const execution = event.observation.latestExecution
        return `${event.threadId}|${execution.status}|${execution.summary}`
      }).join('\n') }
    }
    const eventPrefix = 'OpenAgent Agent Thread terminal event:\n'
    if (directive.includes(eventPrefix)) {
      const event = JSON.parse(directive.slice(directive.lastIndexOf(eventPrefix) + eventPrefix.length).split('\n', 1)[0])
      assert.ok(event.threadId && event.observation?.latestExecution, 'Malformed terminal history injection')
      return { text: `Observed ${event.threadId}: ${event.observation.latestExecution.summary}` }
    }
    const key = turnKey(request)
    let turn = turns.get(key)
    if (!turn) {
      assert.ok(request.toolNames.every(name => /(?:^|__)openagent_/.test(name)),
        'Bart exclusive session exposed native tools: ' + request.toolNames.join(', '))
      const calls = parseBartDirective(directive, request.systemMessage)
      assert.ok(calls.length, `Unscripted Bart directive: ${directive.slice(0, 160)}`)
      turn = { calls, index: 0, waiting: undefined }
      turns.set(key, turn)
    }
    if (turn.waiting) {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === turn.waiting)
      assert.ok(result?.content, 'Bart CLI omitted the preceding Core tool result')
      turn.waiting = undefined
      turn.index++
    }
    if (turn.index === turn.calls.length) return { text: 'Acceptance tool sequence completed.' }
    const call = turn.calls[turn.index]
    const tool = request.tools.find(candidate => candidate.name === call.name || candidate.name.endsWith('__' + call.name))
    assert.ok(tool, `Core tool ${call.name} is absent from the LLM request`)
    const id = `call_${randomUUID()}`
    turn.waiting = id
    return { tools: [{ id, name: tool.name, args: call.args }] }
  })
}

export function turnKey(request) {
  const last = request.messages.findLastIndex(message => message.role === 'user')
  // Provider billing headers can change between calls in the same turn.
  return createHash('sha256').update(JSON.stringify(request.messages.slice(0, last + 1)
    .filter(message => message.role !== 'system'))).digest('hex')
}

function parseBartDirective(text, system) {
  const batch = text.match(/Call (openagent_\w+) exactly three times/)
  if (batch) return text.slice(batch.index).split('\n').filter(line => line.startsWith('{')).map(line => ({ name: batch[1], args: JSON.parse(line) }))
  if (text.includes('Verify the injected host instructions.')) {
    const receipt = system.match(/headless host injection receipt is ([a-f0-9]+)\./)?.[1]
    assert.ok(receipt, 'Host instruction receipt is missing from HTTP instructions')
    return [{ name: 'openagent_report_create', args: {
      title: JSON.parse(text.match(/Use title (".*") and relatedExecutions/)[1]),
      html: `<p>${receipt}</p>`, relatedExecutions: []
    } }]
  }
  if (text.includes('Use exactly this title:')) {
    return [{ name: 'openagent_report_create', args: {
      title: text.match(/Use exactly this title: (.+)/)[1],
      html: `<p>${text.match(/whose text is exactly ([^.]+)\./)[1]}</p>`,
      relatedExecutions: JSON.parse(text.match(/Set relatedExecutions to exactly (\[.*\])\./)[1])
    } }]
  }
  const calls = []
  for (const line of text.split('\n')) {
    const match = line.match(/(?:First |Then )?[Cc]all (openagent_\w+)\b/)
    if (!match) continue
    const start = line.indexOf('{')
    if (start >= 0) {
      // Fixture JSON is compact and occupies the rest of the line, possibly
      // followed by "and stop". Parse the longest valid JSON prefix.
      calls.push({ name: match[1], args: jsonPrefix(line.slice(start)) })
    } else if (/JSON|exactly once/.test(line)) {
      const json = text.split('\n').findLast(candidate => candidate.startsWith('{'))
      if (json) calls.push({ name: match[1], args: JSON.parse(json) })
    }
  }
  return calls
}

function jsonPrefix(text) {
  for (let end = text.lastIndexOf('}') + 1; end > 0; end = text.lastIndexOf('}', end - 2) + 1) {
    try { return JSON.parse(text.slice(0, end)) } catch { /* next closing brace */ }
  }
  throw new Error('Acceptance directive contains no valid JSON arguments')
}
