import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createAcceptanceLlm } from './mock-llm/server.mjs'
import { installOrdinaryScript } from './mock-llm/ordinary.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('an unrecognised LLM request fails instead of receiving a successful canned answer', async () => {
  const llm = await createAcceptanceLlm()
  try {
    const response = await fetch(`${llm.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
      body: JSON.stringify({ model: 'mock-model', stream: false,
        messages: [{ role: 'user', content: 'This request has no test script.' }] })
    })
    assert.equal(response.status, 400)
    assert.throws(() => llm.assertHealthy(), /Unscripted LLM request/)
  } finally { await assert.rejects(llm.close(), /Unscripted LLM request/) }
})

test('receipt calls are derived from HTTP instructions and history, and missing injection is rejected', async () => {
  const llm = await createAcceptanceLlm()
  installOrdinaryScript(llm)
  const receipts = { instruction: '111a', thread: '222b', seed: '333c', telemetry: '444d', evaluation: '555e', send: '666f' }
  const schema = { type: 'object', required: Object.keys(receipts),
    properties: Object.fromEntries(Object.keys(receipts).map(key => [key, { type: 'string' }])), additionalProperties: false }
  const messages = [
    { role: 'system', content: 'The instruction receipt is 111a. The Thread receipt is 222b. The telemetry receipt is 444d. The evaluation receipt is 555e.' },
    { role: 'user', content: 'Remember the seed receipt 333c.' },
    { role: 'user', content: 'The current send receipt is 666f. Use acceptance_receipt.' }
  ]
  const post = () => fetch(`${llm.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages,
      tools: [{ type: 'function', function: { name: 'acceptance_receipt', parameters: schema } }] })
  })
  try {
    const response = await post()
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), receipts)
    messages[0].content = 'The instruction receipt is 111a.'
    const missing = await post()
    assert.equal(missing.status, 400)
    assert.throws(() => llm.assertHealthy(), /Missing Thread receipt/)
  } finally { await assert.rejects(llm.close(), /Missing Thread receipt/) }
})

test('Anthropic tool results retain their contents and call identities over HTTP', async () => {
  const llm = await createAcceptanceLlm()
  llm.expect(() => true, request => {
    assert.deepEqual(request.messages.filter(message => message.role === 'tool'), [
      { role: 'tool', content: 'result-one', toolCallId: 'call_one' },
      { role: 'tool', content: '{"completionReceipt":"abc123"}', toolCallId: 'call_two' }
    ])
    return 'Observed both results'
  })
  try {
    const response = await fetch(`${llm.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
      body: JSON.stringify({ model: 'mock-model', max_tokens: 100, stream: false,
        messages: [{ role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_one', content: [{ type: 'text', text: 'result-one' }] },
          { type: 'tool_result', tool_use_id: 'call_two', content: '{"completionReceipt":"abc123"}' }
        ] }] })
    })
    assert.equal(response.status, 200)
    llm.assertHealthy()
  } finally { await llm.close() }
})

test('cancelling a slow stream releases the mock process without draining the remaining answer', async () => {
  const source = `
    import { createAcceptanceLlm } from ${JSON.stringify(new URL('./mock-llm/server.mjs', import.meta.url).href)};
    const llm = await createAcceptanceLlm();
    llm.expect(() => true, () => ({ text: 'stream '.repeat(10000) }), { latency: 20, chunkSize: 20 });
    const controller = new AbortController();
    const response = await fetch(llm.url + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' }, signal: controller.signal,
      body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'user', content: 'stream' }] })
    });
    await response.body.getReader().read();
    controller.abort();
    await llm.close();
  `
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 3000 })
})

test('Bart batch ignores JSON context preceding the explicit directive and nested target streaming text', async () => {
  const { installBartScript } = await import('./mock-llm/bart.mjs')
  const { installStreamingScript } = await import('./mock-llm/streaming.mjs')
  const llm = await createAcceptanceLlm()
  installBartScript(llm)
  installStreamingScript(llm)
  const args = [1, 2, 3].map(n => ({ harnessId: 'codex', prompt: `Start with exactly STREAM_${n} on the first line. Output every integer from 1 through 4000.` }))
  try {
    const response = await fetch(`${llm.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
      body: JSON.stringify({ model: 'mock-model', stream: false,
        messages: [{ role: 'user', content: '{"namespace":"quota"}\nCall openagent_thread_start exactly three times, once with each JSON object below.\n' + args.map(arg => JSON.stringify(arg)).join('\n') }],
        tools: ['openagent_thread_list', 'openagent_thread_start'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })) })
    })
    assert.equal(response.status, 200)
    const calls = (await response.json()).choices[0].message.tool_calls
    assert.equal(calls?.[0]?.function.name, 'openagent_thread_start')
    assert.deepEqual(JSON.parse(calls[0].function.arguments), args[0])
    llm.assertHealthy()
  } finally { await llm.close() }
})

test('permission proof is read with the native read tool after the approved write', async () => {
  const { installTargetScript } = await import('./mock-llm/target.mjs')
  const llm = await createAcceptanceLlm()
  installTargetScript(llm, [{
    llmShellCall: ({ command }) => ({ name: 'Bash', args: { command } }),
    llmReadCall: ({ path }) => ({ name: 'Read', args: { file_path: path } })
  }])
  const messages = [{ role: 'user', content: "This is a native claude permission-response acceptance case.\nUse the native Bash tool to run exactly this command: printf %s 'PROOF' > '/tmp/proof.txt'\nAfter approval, read the proof file with a native read-only tool and output exactly PERMISSION_OK:PROOF." }]
  const post = () => fetch(`${llm.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages,
      tools: ['Bash', 'Read'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })) })
  })
  try {
    const first = (await (await post()).json()).choices[0].message
    messages.push(first, { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '(Bash completed with no output)' })
    const second = (await (await post()).json()).choices[0].message.tool_calls[0]
    assert.equal(second.function.name, 'Read')
    assert.deepEqual(JSON.parse(second.function.arguments), { file_path: '/tmp/proof.txt' })
    llm.assertHealthy()
  } finally { await llm.close() }
})

test('malformed protocol requests and unknown routes fail health checks', async () => {
  for (const path of ['/v1/chat/completions', '/unknown']) {
    const llm = await createAcceptanceLlm()
    try {
      const response = await fetch(llm.url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' }, body: JSON.stringify({ stream: false, messages: [] }) })
      assert.ok(response.status >= 400)
      assert.throws(() => llm.assertHealthy(), /HTTP (400|404)/)
    } finally { await assert.rejects(llm.close(), /HTTP (400|404)/) }
  }
})

test('concurrent large native requests retain one complete JSON record per evidence line', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'mock-evidence-'))
  const artifactPath = join(root, 'requests.json')
  const llm = await createAcceptanceLlm({ artifactPath })
  llm.expect(() => true, () => 'acknowledged')
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`${llm.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
      body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: `${index}:` + 'x'.repeat(600000) }] })
    })))
    assert.ok(responses.every(response => response.status === 200))
    await llm.close()
    const lines = (await readFile(artifactPath + 'l', 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.length, 8)
    assert.equal(new Set(lines.map(entry => entry.sequence)).size, 8)
  } finally { await llm.close(); await rm(root, { recursive: true, force: true }) }
})


test('shutdown rejects a late HTTP failure after the earlier health check passed', async () => {
  const llm = await createAcceptanceLlm()
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  llm.expect(() => true, async () => {
    entered()
    await blocked
    throw new Error('late native request failed')
  })
  const response = fetch(`${llm.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer openagent-mock-key' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'pending at native shutdown' }] })
  })
  await started
  llm.assertHealthy()
  const settled = Promise.all([
    assert.rejects(llm.close(), /late native request failed/),
    response.then(result => assert.equal(result.status, 400))
  ])
  release()
  await settled
})
