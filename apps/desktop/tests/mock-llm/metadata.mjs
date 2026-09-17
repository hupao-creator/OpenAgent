import assert from 'node:assert/strict'

/** Metadata is another real CLI request, with a narrowly scoped fixture of its own. */
export function installMetadataScript(llm, adapters) {
  llm.expect(request => (request.systemMessage + request.messages.map(message => message.content).join('\n'))
    .includes('You classify OpenAgent Agent Thread metadata.'), request => {
    const contexts = adapters.map(adapter => adapter.llmMetadataContext?.(request)).filter(Boolean)
    assert.equal(contexts.length, 1, 'No unique native metadata dialect')
    const { content, replyTool } = contexts[0]
    const encoded = content.match(/<thread_metadata_context>(.*?)<\/thread_metadata_context>/s)?.[1]
    assert.ok(encoded, 'Metadata request omitted Thread context')
    const context = JSON.parse(encoded)
    assert.ok(context.thread?.id && context.initialUserIntent?.length, 'Metadata request omitted initial intent')
    const args = { title: 'Headless acceptance', emoji: '🧪', tags: [{ name: 'Harness', description: 'Native harness acceptance tests' }] }
    return replyTool ? { tools: [{ name: replyTool, args }] } : { text: JSON.stringify(args) }
  })
}
