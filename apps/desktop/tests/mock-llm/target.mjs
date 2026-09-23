import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { turnKey } from './bart.mjs'

/** Native tools execute in the CLI; this resolver only supplies the model's decisions. */
export function installTargetScript(llm, adapters) {
  const turns = new Map()
  llm.expect(request => !request.toolNames.some(name => name.includes('thread_list')), request => {
    const prompt = request.lastMessage
    if (prompt.startsWith('Read the source ') && prompt.includes('Thread history as evidence')) {
      const token = prompt.match(/(?:for|produced for) ([A-Z0-9_]+)\./)?.[1]
      const answer = request.messages.findLast(message => message.role === 'assistant' && token && message.content.includes(token))
      assert.ok(answer, 'Read request did not carry the prior native answer in HTTP history')
      return { text: answer.content }
    }
    const notifications = adapters.map(adapter => adapter.llmNotificationReply?.(request)).filter(Boolean)
    assert.ok(notifications.length <= 1, 'Multiple native notification dialects matched')
    if (notifications.length) return { text: notifications[0] }
    const key = turnKey(request)
    let turn = turns.get(key)
    if (!turn) { turn = { calls: [] }; turns.set(key, turn) }
    const results = turn.calls.map(id => request.messages.find(message => message.role === 'tool' && message.toolCallId === id))
    assert.ok(results.every(result => result?.content), 'Native CLI omitted the preceding tool result')
    const result = results.at(-1)?.content
    if (result && /denied|rejected|declined|doesn.t want|cancelled|canceled|取消|拒绝/i.test(result)) {
      const marker = prompt.match(/(?:PERMISSION_DENIED|QUESTION_CANCELLED):[A-Z0-9_]+/)?.[0]
      assert.ok(marker, 'Native tool was denied unexpectedly: ' + result)
      return { text: marker }
    }
    const issue = call => {
      assert.ok(call, 'Requested native tool is missing from the HTTP tool schemas')
      const id = `call_${randomUUID()}`
      turn.calls.push(id)
      return { tools: [{ id, ...call }] }
    }
    const shell = (command, permission = false, background = false) => {
      const candidates = adapters.map(adapter => adapter.llmShellCall({ command, toolNames: request.toolNames, permission, background })).filter(Boolean)
      assert.equal(candidates.length, 1, 'No unique native shell dialect for: ' + request.toolNames.join(', '))
      return issue(candidates[0])
    }
    if (/question-response acceptance|multi-select response acceptance/.test(prompt)) {
      const token = prompt.match(/Alpha-([A-Z0-9_]+)/)?.[1]
      assert.ok(token, 'Native question fixture omitted its token')
      const multiple = prompt.includes('multi-select response')
      const options = ['Alpha', 'Beta', 'Gamma'].map(label => `${label}-${token}`)
      if (!result) {
        const candidates = adapters.map(adapter => adapter.llmQuestionCall?.({ toolNames: request.toolNames, options, multiple })).filter(Boolean)
        assert.equal(candidates.length, 1, 'No unique native question dialect')
        return issue(candidates[0])
      }
      const selected = options.filter(option => result.includes(option))
      assert.equal(selected.length, multiple ? 2 : 1, 'Native question result omitted the actual selected answers')
      return { text: `${multiple ? 'QUESTION_MULTI_OK' : 'QUESTION_OK'}:${token}:${selected.join('|')}` }
    }
    const command = prompt.match(/(?:run|Run) exactly this command[^\n]*?: ([^\n]+)/)?.[1]
      ?? prompt.match(/tool to run exactly this command: ([^\n]+)/)?.[1]
      ?? prompt.match(/tool exactly once to run: ([^\n]+)/)?.[1]
    if (command) {
      if (!result) return shell(command, prompt.includes('permission-response acceptance'), prompt.includes('yield after 1000ms'))
      if (!prompt.includes('yield after 1000ms')) {
        const continuations = adapters.map(adapter => adapter.llmContinueShellCall?.({ result, toolNames: request.toolNames })).filter(Boolean)
        assert.ok(continuations.length <= 1, 'Multiple native shell continuation dialects matched')
        if (continuations.length) return issue(continuations[0])
      }
      if (prompt.includes('permission-response acceptance')) {
        const path = command.match(/> (.+)$/)?.[1]
        assert.ok(path, 'Permission proof omitted its path')
        if (results.length === 1) {
          const unquotedPath = path.replace(/^'|'$/g, '')
          const reads = adapters.map(adapter => adapter.llmReadCall?.({ path: unquotedPath, toolNames: request.toolNames })).filter(Boolean)
          assert.ok(reads.length <= 1, 'Multiple native read dialects matched')
          return reads.length ? issue(reads[0]) : shell(`cat ${path}`)
        }
        const token = prompt.match(/PERMISSION_OK:([A-Z0-9_]+)/)?.[1]
        assert.ok(token && result.includes(token), 'Native read did not return the written proof')
      }
    }
    const marker = prompt.match(/(?:[Rr]eply|output|response) with exactly ([A-Z][A-Z0-9_:.-]+)/)?.[1]
      ?? prompt.match(/output exactly ([A-Z][A-Z0-9_:.-]+)/)?.[1]
    assert.ok(marker, `Unscripted target prompt: ${prompt.slice(0, 180)}`)
    return { text: marker.replace(/\.$/, '') }
  })
}
