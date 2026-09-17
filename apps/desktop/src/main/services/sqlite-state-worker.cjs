// Private static worker program bundled by Vite. No application/Thread authority.
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const { mkdirSync, statSync, chmodSync } = require('node:fs')
const { dirname } = require('node:path')
const MAX_BYTES = 50 * 1024 * 1024
let db
let writes

function open(readOnly = false) {
  if (db) return db
  if (!readOnly) mkdirSync(dirname(workerData.path), { recursive: true, mode: 0o700 })
  const connection = new DatabaseSync(workerData.path, { readOnly })
  try {
    connection.exec('PRAGMA busy_timeout=2000')
    const version = connection.prepare('PRAGMA user_version').get().user_version
    if (version !== 6) {
      // A first-write exit may leave a valid empty file before schema COMMIT.
      // Only an empty version-zero database is uninitialized; never adopt a
      // foreign schema, even if it currently contains only views or indexes.
      if (version !== 0 || connection.prepare('SELECT name FROM sqlite_master LIMIT 1').get()) {
        throw new Error('OpenAgent 状态不符合当前格式')
      }
      if (readOnly) { connection.close(); return null }
    }
    if (!readOnly) {
      chmodSync(workerData.path, 0o600)
      // Larger pages reduce large-BLOB pager/WAL overhead. SQLite preserves
      // the page size of existing databases, including interrupted WAL files.
      if (version === 0) connection.exec('PRAGMA page_size=8192')
      connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000')
      if (connection.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error('SQLite WAL mode unavailable')
      if (version === 0) connection.exec(`BEGIN IMMEDIATE;
        CREATE TABLE records (key TEXT PRIMARY KEY, body BLOB NOT NULL CHECK(length(body)<=52428800), html BLOB CHECK(length(html)<=52428800)) STRICT;
        CREATE TABLE entity_order (kind TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, position), UNIQUE(kind,id)) STRICT;
        PRAGMA user_version=6; COMMIT;`)
    }
    db = connection
    return db
  } catch (error) { connection.close(); throw error }
}

function encode(value, key) {
  const text = typeof value === 'string' && key === 'html' ? value : JSON.stringify(value)
  if (text === undefined) throw new Error('OpenAgent 状态无法序列化')
  const size = Buffer.byteLength(text)
  if (size > MAX_BYTES) throw new Error(`OpenAgent ${key} 记录超过 50 MB，无法读写`)
  // Own this exact ArrayBuffer so transferring it does not copy a pooled slab.
  const bytes = new Uint8Array(size)
  Buffer.from(bytes.buffer).write(text)
  return bytes
}

function prepare(parts) {
  return parts.map(([key, value]) => {
    if (value === undefined) return { key, deleted: true }
    if ((key === 'thread-order' || key === 'report-order')) return { key, order: value }
    if (key.startsWith('report:')) {
      const { html, ...metadata } = value
      return { key, body: encode(metadata, key), html: encode(html, 'html') }
    }
    return { key, body: encode(value, key) }
  })
}

function load() {
  try { statSync(workerData.path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const connection = open(true)
  if (!connection) return null
  connection.exec('BEGIN')
  try {
    // Check lengths before materializing blobs; no whole-database size budget.
    const sizes = connection.prepare('SELECT key, length(body) AS size, length(html) AS htmlSize FROM records').all()
    if (sizes.length === 0) {
      if (connection.prepare('SELECT id FROM entity_order LIMIT 1').get()) throw new Error('OpenAgent 状态不符合当前格式')
      connection.exec('COMMIT'); return null
    }
    if (sizes.some(row => row.size > MAX_BYTES || row.htmlSize > MAX_BYTES)) throw new Error('OpenAgent 状态记录超过容量限制，无法读取')
    const parts = connection.prepare('SELECT key, body, html FROM records').all().map(row => {
      const value = JSON.parse(Buffer.from(row.body).toString('utf8'))
      if (row.key.startsWith('report:')) {
        if (row.html === null || !value || typeof value !== 'object' || Array.isArray(value) || 'html' in value) throw new Error('OpenAgent 状态不符合当前格式')
        return [row.key, { ...value, html: Buffer.from(row.html).toString('utf8') }]
      }
      if (row.html !== null) throw new Error('OpenAgent 状态不符合当前格式')
      return [row.key, value]
    })
    for (const kind of ['thread', 'report']) {
      const order = connection.prepare('SELECT position, id FROM entity_order WHERE kind=? ORDER BY position').all(kind)
      if (order.some((row, index) => row.position !== index)) throw new Error('OpenAgent 状态不符合当前格式')
      parts.push([`${kind}-order`, order.map(row => row.id)])
    }
    if (connection.prepare("SELECT kind FROM entity_order WHERE kind NOT IN ('thread','report')").get()) throw new Error('OpenAgent 状态不符合当前格式')
    connection.exec('COMMIT')
    return parts
  } catch (error) { connection.exec('ROLLBACK'); throw error }
}

function commit(parts, fault) {
  const connection = open()
  writes ??= {
    removeOrder: connection.prepare('DELETE FROM entity_order WHERE kind=?'),
    insertOrder: connection.prepare('INSERT INTO entity_order VALUES (?,?,?)'),
    remove: connection.prepare('DELETE FROM records WHERE key=?'),
    upsert: connection.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, html=excluded.html')
  }
  const started = performance.now()
  connection.exec('BEGIN IMMEDIATE')
  try {
    for (const part of parts) {
      if ((part.key === 'thread-order' || part.key === 'report-order')) {
        const kind = part.key === 'thread-order' ? 'thread' : 'report'
        writes.removeOrder.run(kind)
        const insert = writes.insertOrder
        part.order.forEach((id, index) => insert.run(kind, index, id))
      } else if (part.deleted) writes.remove.run(part.key)
      else writes.upsert.run(part.key, part.body, part.html ?? null)
      if (fault === 'statement') {
        // Exercise SQLite's own constraint/error path after an earlier write.
        connection.exec("INSERT INTO records(key, body) VALUES ('injected-failure', NULL)")
      }
    }
    if (fault === 'before-commit') process.exit(91)
    connection.exec('COMMIT')
  } catch (error) { connection.exec('ROLLBACK'); throw error }
  if (fault === 'after-commit') process.exit(92)
  return { transactionMs: performance.now() - started }
}

parentPort.on('message', ({ id, operation, parts, fault }) => {
  try {
    let result
    if (operation === 'prepare') {
      if (fault === 'exit') process.exit(93)
      result = prepare(parts)
    }
    else if (operation === 'load') result = load()
    else if (operation === 'commit') result = commit(parts, fault)
    else if (operation === 'close') { if (db) { db.close(); db = undefined; writes = undefined } }
    else throw new Error('Unknown SQLite worker operation')
    const transfers = operation === 'prepare' ? result.flatMap(part => [part.body?.buffer, part.html?.buffer].filter(Boolean)) : []
    parentPort.postMessage({ id, result }, transfers)
  } catch (error) {
    parentPort.postMessage({ id, error: error.message })
  }
})
