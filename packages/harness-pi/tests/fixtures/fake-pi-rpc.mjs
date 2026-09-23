#!/usr/bin/env node
// Programmable Pi 0.83 RPC process double. Each command selects its own reply
// framing, ordering or failure mode, so a test can drive chunk boundaries,
// out-of-order correlation and cancellation without a spawn-time plan.
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) {
  if (process.env.PI_RPC_FIXTURE_VERSION_MARKER) appendFileSync(process.env.PI_RPC_FIXTURE_VERSION_MARKER, 'probe\n')
  if (process.env.PI_RPC_FIXTURE_VERSION_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.PI_RPC_FIXTURE_VERSION_DELAY)))
  if (process.env.PI_RPC_FIXTURE_VERSION_HANG) await new Promise(() => setInterval(() => {}, 1_000))
  if (process.env.PI_RPC_FIXTURE_VERSION_ERROR) {
    process.stderr.write('SECRET_VERSION_DIAGNOSTIC\n')
    process.exit(1)
  }
  if (process.env.PI_RPC_FIXTURE_VERSION_SIGNAL) process.kill(process.pid, 'SIGTERM')
  if (process.env.PI_RPC_FIXTURE_VERSION_OVERSIZED) {
    await new Promise(resolve => process.stderr.write('SECRET_VERSION_DIAGNOSTIC'.repeat(200), resolve))
  }
  process.stdout.write(`${process.env.PI_RPC_FIXTURE_VERSION ?? '0.83.0'}\n`)
  process.exit(0)
}
if (process.env.PI_RPC_FIXTURE_IGNORE_TERM) process.on('SIGTERM', () => {})
else if (process.env.PI_RPC_FIXTURE_EXIT_MARKER) process.on('SIGTERM', () => process.exit(0))
process.on('exit', () => {
  try { if (process.env.PI_RPC_FIXTURE_EXIT_MARKER) writeFileSync(process.env.PI_RPC_FIXTURE_EXIT_MARKER, 'exited') } catch { /* Marker is best-effort. */ }
})
// Writes issued in the same turn of the event loop are coalesced into one pipe read, so
// the double waits for each write to drain before issuing the next. The boundary a
// decoder can see is the one that falls inside a multi-byte UTF-8 sequence: that is where
// a per-chunk decode breaks and where an encoding-unaware assembly mangles the text. The
// double yields a real timer once per record, at the first such boundary, so that read
// reaches the reader on its own instead of in one burst with the rest of the record.
const write = bytes => new Promise(resolve => { process.stdout.write(bytes, resolve) })
const yieldToReader = () => new Promise(resolve => { setTimeout(resolve, 2) })
const continuesCharacter = byte => (byte & 0xc0) === 0x80
// Sizes are cycled over the UTF-8 bytes of one emitted record.
async function chunked(text, sizes, crlf = false) {
  const bytes = Buffer.from(crlf ? `${text}\r\n` : `${text}\n`)
  if (!Array.isArray(sizes) || !sizes.length) { await write(bytes); return }
  let offset = 0
  let index = 0
  let split = false
  while (offset < bytes.length) {
    const size = sizes[index++ % sizes.length]
    await write(bytes.subarray(offset, offset + size))
    offset += size
    if (!split && offset < bytes.length && continuesCharacter(bytes[offset])) {
      split = true
      await yieldToReader()
    }
  }
}
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const envSplit = () => { try { return JSON.parse(process.env.PI_RPC_FIXTURE_HANDSHAKE_SPLIT ?? 'null') } catch { return null } }
const held = []
const ORDER = {
  forward: list => list,
  reverse: list => [...list].reverse(),
  alternate: list => [...list.filter((_, i) => i % 2 === 0), ...list.filter((_, i) => i % 2 === 1)]
}
// Commands are handled one at a time: a chunked reply awaits between its own chunks,
// and serializing the handler keeps every reply's records in the order it emitted them.
let queued = Promise.resolve()
createInterface({ input: process.stdin }).on('line', line => { queued = queued.then(() => handle(JSON.parse(line))).catch(() => undefined) })
async function handle(command) {
  const response = (data = {}) => emit({ type: 'response', id: command.id, command: command.type, success: true, data })
  switch (command.type) {
    case 'get_state': {
      if (process.env.PI_RPC_FIXTURE_HANDSHAKE_MARKER) writeFileSync(process.env.PI_RPC_FIXTURE_HANDSHAKE_MARKER, 'ready')
      if (process.env.PI_RPC_FIXTURE_NO_HANDSHAKE) break
      // The handshake is the one record a caller cannot ask to be chunked.
      await chunked(JSON.stringify({ type: 'response', id: command.id, command: 'get_state', success: true, data: { sessionId: 'fixture', model: { id: 'fake' } } }), command.split ?? envSplit())
      break
    }
    case 'echo': {
      if (command.hold === true) { held.push({ id: command.id, value: command.value }); break }
      await chunked(JSON.stringify({ type: 'response', id: command.id, command: 'echo', success: true, data: { value: command.value } }), command.split, command.crlf)
      break
    }
    case 'release': {
      const order = ORDER[command.order] ?? ORDER.forward
      const entries = held.splice(0)
      for (const entry of order(entries)) emit({ type: 'response', id: entry.id, command: 'echo', success: true, data: { value: entry.value } })
      response({ released: entries.length })
      break
    }
    case 'split': {
      const value = Buffer.from(JSON.stringify({ type: 'response', id: command.id, success: true, data: { value: 'a\u2028b\u2029中' } }) + '\r\n')
      const position = value.indexOf(Buffer.from('中')) + 1
      setTimeout(async () => {
        await write(value.subarray(0, position))
        await yieldToReader()
        await write(value.subarray(position))
      }, 5)
      break
    }
    case 'prompt': response(); setTimeout(() => emit({ type: 'agent_settled' }), 80); break
    // A non-response record takes the same generated framing as an echo, so record
    // reassembly is exercised for events, not only for correlated responses. The
    // caller's value rides along, so a generated chunk can land inside its text.
    case 'event': await chunked(JSON.stringify({ type: 'extension_ui_request', id: 'dialog', method: 'input', ...(command.value === undefined ? {} : { value: command.value }) }), command.split, command.crlf); response(); break
    case 'extension_ui_response': emit({ type: 'received_ui', value: command.value }); break
    // A response for an id the caller never issued. The caller cannot forge one by
    // writing it to stdin — a response only means anything on stdout — so the double
    // emits it and the reader is what decides whether an unknown id is dropped.
    case 'forge': emit({ type: 'response', id: command.id, success: true, data: { value: command.value } }); break
    case 'reject': emit({ type: 'response', id: command.id, success: false, error: 'SECRET_NATIVE_ERROR' }); break
    case 'exit': process.stderr.write('SECRET_STDERR'); process.exit(9); break
    case 'halt': process.exit(3); break
    case 'invalid': process.stdout.write('SECRET_INVALID_JSON\n'); break
    case 'oversized': process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); break
    case 'break': process.stdout.end(); break
    case 'truncate': process.stdout.write('{"type":"response","id":"'); process.stdout.end(); break
    case 'hang': break
  }
}
