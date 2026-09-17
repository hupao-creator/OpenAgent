import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { isConfigTempCollision } from './build-config-collision.mjs'

const target = process.argv[2]
if (!['main', 'preload', 'renderer'].includes(target)) throw new Error(`Unknown build target: ${target}`)
process.env.NODE_ENV_ELECTRON_VITE = 'production'
// The cached build runs these targets one at a time, but a concurrent invocation still
// shares electron-vite's temp config path; retry that collision, never a real config error.
let resolved
for (let attempt = 0; !resolved; ) {
  try { resolved = await resolveConfig({}, 'build', 'production') }
  catch (error) {
    if (++attempt >= 5 || !isConfigTempCollision(error)) throw error
  }
}
const { config } = resolved
const selected = config?.[target]
if (!selected) throw new Error(`Missing ${target} build configuration`)
if (selected.build?.watch) selected.build.watch = null
if (target !== 'renderer') {
  selected.plugins ??= []
  selected.plugins.push({
    name: 'native-cache-input-boundary',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (/\/src\/renderer\/.*\.css(?:\?|$)/.test(id)) {
          this.error('Native builds must not consume renderer CSS excluded from their cache inputs')
        }
      }
    }
  })
}
await build(selected)
