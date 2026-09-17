#!/usr/bin/env node
// Small native stream-json peer: no model, network, or timer-based ordering.
const readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('property-fixture-1'); process.exit(0) }
const sessionArg = process.argv.find(arg => arg.startsWith('--session-id=') || arg.startsWith('--resume='))
const session = sessionArg ? sessionArg.slice(sessionArg.indexOf('=') + 1) : 'fixture-session'
const scenario = JSON.parse(process.env.NATIVE_PROPERTY_SCENARIO)
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line)
  if (value.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } })
    return
  }
  if (value.type !== 'user') return
  send({ type: 'user', message: value.message, parent_tool_use_id: null, session_id: session, uuid: value.uuid, isReplay: true, origin: { kind: 'human' } })
  send({ type: 'system', subtype: 'init', session_id: session, model: 'sonnet', cwd: process.cwd() })
  for (const text of scenario.chunks) send({ type: 'stream_event', user_message_uuid: value.uuid,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  if (scenario.background) send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'background-property', task_type: 'agent', description: 'Independent background task', status: 'running' }] })
  send({ type: 'result', session_id: session, user_message_uuid: value.uuid,
    subtype: scenario.failed ? 'error_during_execution' : 'success', is_error: scenario.failed,
    ...(scenario.failed ? { errors: ['fixture failure'] } : {}), result: '', origin: { kind: 'human' } })
})
