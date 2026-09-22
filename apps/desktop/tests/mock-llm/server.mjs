import assert from 'node:assert/strict'
import { appendFile, writeFile } from 'node:fs/promises'
import { createMock } from 'llm-mock-server'
import { createServer, request as httpRequest } from 'node:http'
import { completeRequest } from './request.mjs'

/**
 * The only test double is the external LLM HTTP endpoint. No product state is
 * available here.
 *
 * `beforeReply` is the controlled-race seam: it runs after the request has been
 * projected and recorded but before any fixture chooses a reply, so a caller can
 * suspend one turn, drive the product, and release it. It may only inspect the
 * request, never product state.
 */
export async function createAcceptanceLlm({ artifactPath, beforeReply, model = 'mock-model', apiKey = 'openagent-mock-key', remaining = 100 } = {}) {
  const failures = []
  const requests = []
  let writing = Promise.resolve()
  const persist = entry => {
    // appendFile may split large records into writes; concurrent appends would interleave JSON lines.
    if (artifactPath) writing = writing.then(() => appendFile(artifactPath + 'l', JSON.stringify(entry) + '\n'))
    return writing
  }
  const server = await createMock({ defaultChunkSize: 7, onRejectedRequest: async request => {
    const error = `HTTP ${request.statusCode}: ${request.method} ${request.url}`
    const entry = { sequence: requests.length, request, error }
    requests.push(entry)
    failures.push(error)
    await persist(entry)
  } })
  server.fallback({ error: { status: 400, message: 'Unscripted LLM request' } })
  async function resolve(parsed, reply) {
    const request = completeRequest(parsed)
    const entry = { sequence: requests.length, request }
    requests.push(entry)
    try {
      assert.equal(request.model, model, 'CLI requested an unexpected model')
      if (beforeReply) await beforeReply(request)
      assert.ok(reply, `Unscripted LLM request: ${request.lastMessage.slice(0, 180)}`)
      entry.reply = await reply(request)
      return entry.reply
    } catch (error) {
      entry.error = error.message
      failures.push(error.message)
      return { error: { status: 400, message: error.message } }
    } finally {
      await persist(entry)
    }
  }
  server.when(() => true).reply(parsed => resolve(parsed))
  let accountRequests = 0
  const gateway = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${apiKey}` && req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401).end(); return
    }
    if (req.url === '/openagent-test/telemetry') {
      accountRequests++
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ remaining }))
      return
    }
    const upstream = httpRequest(new URL(req.url, server.url), { method: req.method, headers: req.headers }, response => {
      // Hop-by-hop keepalive belongs to each server, not the proxied response.
      const headers = { ...response.headers }
      delete headers.connection
      delete headers['keep-alive']
      res.writeHead(response.statusCode, headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.destroyed) { if (!res.headersSent) res.writeHead(502); res.end() } })
    res.once('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  })
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${gateway.address().port}`
  function assertHealthy(since = 0) {
    const errors = requests.slice(since).filter(entry => entry.error).map(entry => entry.error)
    assert.equal(errors.length, 0, errors.join('\n'))
  }
  let closing
  return {
    url,
    connection: { id: 'acceptance-mock', providerId: 'mock', model, apiKey, baseUrl: url },
    providerOverride: { provider: 'mock', model, apiKey, baseUrl: url },
    get accountRequests() { return accountRequests },
    expect(match, reply, options) {
      server.when(parsed => match(completeRequest(parsed)))
        .reply(parsed => resolve(parsed, reply), options).first()
    },
    assertHealthy,
    get requestCount() { return requests.length },
    get requests() { return structuredClone(requests) },
    close() {
      return closing ??= (async () => {
        const errors = []
        // Drain native requests before the final health check. Every cleanup is
        // attempted even if shutdown or evidence persistence itself fails.
        for (const cleanup of [
          () => new Promise((resolve, reject) => { gateway.close(error => error ? reject(error) : resolve()); gateway.closeIdleConnections() }),
          () => server.stop(),
          () => writing,
          () => artifactPath && writeFile(artifactPath, JSON.stringify({ requests, failures }, null, 2) + '\n'),
          () => assertHealthy()
        ]) {
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '))
      })()
    }
  }
}
