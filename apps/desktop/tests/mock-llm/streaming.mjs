import assert from 'node:assert/strict'

/** Long answers are deliberately paced so cancellation observes actual generated text. */
export function installStreamingScript(llm) {
  llm.expect(request => (!request.toolNames.some(name => name.endsWith('thread_list')) || request.lastMessage.includes('This is a Bart cancellation acceptance case.')) && /(?:every integer from 1 to 20000|every integer from 1 through 4000)/.test(request.lastMessage), request => {
    const prompt = request.lastMessage
    const marker = prompt.match(/Start with exactly ([A-Z0-9_:]+) on the first line/)?.[1]
    assert.ok(marker || prompt.includes('Bart cancellation acceptance case'), 'Unscripted streaming answer')
    const count = marker ? 4000 : 20000
    return { text: [...(marker ? [marker] : []), ...Array.from({ length: count }, (_, index) => String(index + 1))].join('\n') }
  }, { latency: 30, chunkSize: 32 })
}
