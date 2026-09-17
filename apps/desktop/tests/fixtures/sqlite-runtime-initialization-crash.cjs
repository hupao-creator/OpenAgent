// Reproduce a native process dying inside the very first schema transaction.
// Deliberately omit COMMIT, rollback, DatabaseSync.close and Electron app.quit.
const { app } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const root = process.env.OPENAGENT_SQLITE_CASE_ROOT
if (!root) throw new Error('A test-owned OPENAGENT_SQLITE_CASE_ROOT is required')
app.setPath('home', join(root, 'home'))
app.setPath('userData', join(root, 'user-data'))
const path = join(root, 'user-data/openagent-state-v6/state.sqlite')
mkdirSync(dirname(path), { recursive: true })
const db = new DatabaseSync(path)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
db.exec(`
  CREATE TABLE records (key TEXT PRIMARY KEY, body BLOB NOT NULL CHECK(length(body)<=52428800), html BLOB CHECK(length(html)<=52428800)) STRICT;
  CREATE TABLE entity_order (kind TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, position), UNIQUE(kind,id)) STRICT;
  PRAGMA user_version=6;
`)
writeFileSync(join(root, 'initialization-boundary.json'), JSON.stringify({
  pid: process.pid, versions: process.versions, boundary: 'schema-created-before-first-commit',
  inTransactionVersion: db.prepare('PRAGMA user_version').get(),
  inTransactionSchema: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
}, null, 2) + '\n')
process.exit(93)
