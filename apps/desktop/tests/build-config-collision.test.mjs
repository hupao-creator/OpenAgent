import { describe, expect, it } from 'vitest'
import { isConfigTempCollision } from '../scripts/build-config-collision.mjs'

// electron-vite writes its transpiled config to `electron.vite.config.<Date.now()>.mjs` and
// unlinks it after import, so two target builds in the same millisecond race the same path.
// A guard that only knows one of the two symptoms silently rethrows the other, which is how
// this reached CI: the missing-file shape reports ERR_MODULE_NOT_FOUND rather than ENOENT.
describe('electron-vite temp config collision', () => {
  const missing = Object.assign(
    new Error("Cannot find module '/repo/apps/desktop/electron.vite.config.1789634554040.mjs' imported from /repo/node_modules/electron-vite/dist/chunks/lib.js"),
    { code: 'ERR_MODULE_NOT_FOUND' })

  it('recognises the unlink race by the temp config name', () => {
    expect(isConfigTempCollision(missing)).toBe(true)
    expect(isConfigTempCollision(new Error(missing.message))).toBe(false)
  })

  it('recognises the truncate race, which carries no code and no filename', () => {
    expect(isConfigTempCollision(new Error('config must export or return an object'))).toBe(true)
  })

  // The empty-module message is accepted on its text alone, because the truncate race leaves
  // nothing else to match on. A config that genuinely exports nothing lands on that same
  // message; it is not a collision, but it exhausts the attempts and still propagates.
  it('leaves unrelated failures to propagate', () => {
    for (const error of [
      Object.assign(new Error("Cannot find module '/repo/config/real.ts'"), { code: 'ERR_MODULE_NOT_FOUND' }),
      Object.assign(new Error('Failed to resolve import "missing-package"'), { code: 'ERR_MODULE_NOT_FOUND' }),
      new Error('Unexpected token'),
      undefined
    ]) expect(isConfigTempCollision(error)).toBe(false)
  })
})
