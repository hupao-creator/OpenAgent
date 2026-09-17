// Standalone selection probe. Run with Node or Electron; see SQLITE_BASELINE.md.
const { DatabaseSync } = require('node:sqlite')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const { join } = require('node:path')
const { mkdirSync, statSync } = require('node:fs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
function open(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, html TEXT)')
  return db
}
function write(db, payload, html, seq) {
  const began = performance.now()
  const json = JSON.stringify(payload)
  const serializedMs = performance.now() - began
  const tx = performance.now()
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT OR REPLACE INTO threads VALUES (?,?)').run('large', json)
  db.prepare('INSERT OR REPLACE INTO reports VALUES (?,?)').run('report', html + seq)
  db.exec('COMMIT')
  return { serializedMs, transactionMs: performance.now()-tx, bytes: Buffer.byteLength(json)+Buffer.byteLength(html) }
}
if (!isMainThread) {
  const db = open(workerData.path)
  parentPort.postMessage({ ready: true, versions: process.versions, sqlite: db.prepare('SELECT sqlite_version() AS version').get() })
  parentPort.on('message', message => {
    if (message.close) { db.close(); parentPort.postMessage({ closed:true }); parentPort.close(); return }
    parentPort.postMessage(write(db, message.payload, message.html, message.seq))
  })
} else {
  ;(async () => {
    if (!process.env.PROBE_OUTPUT_DIRECTORY) throw new Error('Set PROBE_OUTPUT_DIRECTORY to a local evidence directory')
    const root = join(process.env.PROBE_OUTPUT_DIRECTORY, 'data-' + process.pid)
    mkdirSync(root, { recursive:true })
    const payload = { messages:[{ text:'s'.repeat(8*1024*1024-50) }] }
    const html = '😀'.repeat(1_000_000)
    const results = []
    for (const mode of ['main', 'worker']) {
      const path=join(root, mode+'.sqlite')
      let db, worker, runtime
      if (mode==='main') { db=open(path); runtime=process.versions }
      else { worker=new Worker(__filename, { workerData:{path} }); runtime=await new Promise((r,j)=>{worker.once('message',r);worker.once('error',j)}) }
      const lags=[]; let previous=performance.now()
      const timer=setInterval(()=>{const now=performance.now();lags.push(Math.max(0,now-previous-2));previous=now},2)
      const writes=[]
      await sleep(20)
      for (let seq=0;seq<8;seq++) {
        const began=performance.now()
        let result
        if (db) result=write(db,payload,html,seq)
        else result=await new Promise((resolve,reject)=>{ worker.once('message',resolve); worker.once('error',reject); worker.postMessage({payload,html,seq}) })
        writes.push({...result,endToEndMs:performance.now()-began})
        await sleep(5)
      }
      await sleep(20); clearInterval(timer)
      if (db) db.close()
      else {await new Promise(r=>{worker.once('message',r);worker.postMessage({close:true})});await new Promise(r=>worker.once('exit',r))}
      const verify=open(path)
      const recovered=verify.prepare('SELECT payload FROM threads').get()
      const recoveredReport=verify.prepare('SELECT html FROM reports').get()
      require('node:assert/strict').deepEqual(JSON.parse(recovered.payload), payload)
      require('node:assert/strict').equal(recoveredReport.html, html + 7)
      verify.close()
      lags.sort((a,b)=>a-b)
      results.push({mode,runtime,writes,loop:{maxMs:lags.at(-1),p99Ms:lags[Math.floor(lags.length*.99)],samples:lags.length},recovered:{bytes:Buffer.byteLength(recovered.payload),reportCharacters:[...recoveredReport.html].length},diskBytes:statSync(path).size,rss:process.memoryUsage().rss})
    }
    console.log(JSON.stringify({platform:process.platform,arch:process.arch,results},null,2))
  })().then(()=>{if(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) require("electron").app.exit(0)}).catch(e=>{console.error(e);if(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) require("electron").app.exit(1);else process.exitCode=1})
}
