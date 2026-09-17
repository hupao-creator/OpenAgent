/** Preserve every tool result, including Anthropic's multiple results in one message. */
export function completeRequest(request) {
  const raw = request.raw
  let messages
  if (request.format === 'anthropic') {
    messages = raw.messages.flatMap(message => {
      if (typeof message.content === 'string') return [message]
      return message.content.flatMap(block => {
        if (block.type === 'tool_result') return [{ role: 'tool', content: contentText(block.content), toolCallId: block.tool_use_id }]
        if (block.type === 'text') return [{ role: message.role, content: block.text }]
        return []
      })
    })
  } else if (request.format === 'responses') {
    messages = typeof raw.input === 'string' ? [{ role: 'user', content: raw.input }]
      : (raw.input ?? []).flatMap(item => {
        if (item.type === 'function_call_output') return [{ role: 'tool', content: contentText(item.output), toolCallId: item.call_id }]
        if (item.role) return [{ role: item.role === 'developer' ? 'system' : item.role, content: contentText(item.content) }]
        return []
      })
  } else {
    messages = raw.messages.map(message => ({ role: message.role, content: contentText(message.content),
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}) }))
  }
  const systemMessage = [request.format === 'anthropic' ? contentText(raw.system)
    : request.format === 'responses' ? raw.instructions ?? '' : '',
    ...messages.filter(message => message.role === 'system').map(message => message.content)].filter(Boolean).join('\n')
  return { ...request, messages, systemMessage,
    lastMessage: messages.findLast(message => message.role === 'user')?.content ?? '',
    lastToolCallId: messages.at(-1)?.role === 'tool' ? messages.at(-1).toolCallId : undefined }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(block => block.text ?? '').join('\n')
  return content == null ? '' : JSON.stringify(content)
}
