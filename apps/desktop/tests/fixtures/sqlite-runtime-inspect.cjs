// Independent read-only verification, run in the exact Electron runtime.
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[2], { readOnly: true })
try {
  if (process.argv[3] === '--initial-empty') {
    console.log(JSON.stringify({
      versions: process.versions,
      integrity: db.prepare('PRAGMA integrity_check').all(),
      journal: db.prepare('PRAGMA journal_mode').get(),
      version: db.prepare('PRAGMA user_version').get(),
      pageSize: db.prepare('PRAGMA page_size').get(),
      schema: db.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all()
    }))
  } else {
    const records = db.prepare('SELECT key, body, length(body) AS bytes, length(html) AS htmlBytes FROM records').all()
    const settings = records.find(row => row.key === 'settings')
    console.log(JSON.stringify({
      versions: process.versions,
      integrity: db.prepare('PRAGMA integrity_check').all(),
      journal: db.prepare('PRAGMA journal_mode').get(),
      version: db.prepare('PRAGMA user_version').get(),
      pageSize: db.prepare('PRAGMA page_size').get(),
      records: records.map(({ key, bytes, htmlBytes }) => ({ key, bytes, htmlBytes })),
      order: db.prepare('SELECT kind, position, id FROM entity_order ORDER BY kind, position').all(),
      settings: settings ? JSON.parse(Buffer.from(settings.body).toString('utf8')) : null
    }))
  }
} finally { db.close() }
