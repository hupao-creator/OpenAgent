// electron-vite transpiles the TypeScript config to `electron.vite.config.<Date.now()>.mjs`
// and unlinks it once imported. Two targets building in the same millisecond share that
// one name, and the loser sees either a missing file or a module whose exports were pulled
// out from under the import. Both are the collision; anything else is a real config error.
const TEMP_CONFIG = /electron\.vite\.config\.\d+\.mjs/
const EMPTY_MODULE = /config must export or return an object/
// A dynamic import of a missing file reports ERR_MODULE_NOT_FOUND, not ENOENT.
const MISSING = new Set(['ERR_MODULE_NOT_FOUND', 'ENOENT'])

export const isConfigTempCollision = error =>
  (MISSING.has(error?.code) && TEMP_CONFIG.test(error?.message ?? ''))
  || EMPTY_MODULE.test(error?.message ?? '')
