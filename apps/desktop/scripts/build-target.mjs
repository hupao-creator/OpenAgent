import { resolveConfig } from 'electron-vite'
import { build } from 'vite'

const target = process.argv[2]
if (!['main', 'preload', 'renderer'].includes(target)) throw new Error(`Unknown build target: ${target}`)
process.env.NODE_ENV_ELECTRON_VITE = 'production'
const { config } = await resolveConfig({}, 'build', 'production')
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
