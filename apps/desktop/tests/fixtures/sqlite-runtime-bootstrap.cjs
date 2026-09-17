// Test-only transport instrumentation around the unchanged production bundle.
// State is exercised exclusively through the application's public commands.
const { app } = require('electron')
const fs = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const workerThreads = require('node:worker_threads')
const { syncBuiltinESMExports } = require('node:module')
const root = process.env.OPENAGENT_SQLITE_CASE_ROOT
const log = (event, detail = {}) => fs.appendFileSync(join(root, 'native.jsonl'), JSON.stringify({ event, pid: process.pid, at: Date.now(), ...detail }) + '\n')
let activeWorkers = 0
const NativeWorker = workerThreads.Worker
workerThreads.Worker = class extends NativeWorker {
  constructor(source, options) {
    super(source, options)
    const sqlite = typeof source === 'string' && source.includes("require('node:sqlite')")
    if (!sqlite) return
    activeWorkers++
    const threadId = this.threadId
    log('worker-created', { threadId })
    this.on('message', message => log('worker-reply', { id: message.id, error: message.error }))
    this.once('exit', code => { activeWorkers--; log('worker-exit', { code, activeWorkers, threadId }) })
    const post = this.postMessage.bind(this)
    this.postMessage = (message, ...rest) => {
      const armed = join(root, 'armed-fault')
      if (fs.existsSync(armed)) {
        const fault = fs.readFileSync(armed, 'utf8').trim()
        if (fault === 'prepare-exit' && message.operation === 'prepare') {
          fs.unlinkSync(armed)
          log('fault-injected', { fault, id: message.id, operation: message.operation, threadId })
          // Kill the real preparation Worker before posting this admitted request.
          // WorkerClient's native exit handler must reject it and poison its owner.
          void this.terminate()
          return
        }
        if (fault !== 'prepare-exit' && message.operation === 'commit' && message.parts?.some(part => part.key === 'settings')) {
          fs.unlinkSync(armed)
          message = { ...message, fault }
          log('fault-injected', { fault, id: message.id })
        }
      }
      if (message.operation === 'close') log('worker-close-request', { id: message.id })
      return post(message, ...rest)
    }
  }
}
syncBuiltinESMExports()
app.on('before-quit', () => log('before-quit', { activeWorkers }))
app.on('will-quit', () => log('will-quit', { activeWorkers }))
app.on('quit', (_event, code) => log('quit', { code, activeWorkers }))
void import(pathToFileURL(process.env.OPENAGENT_SQLITE_MAIN).href)
