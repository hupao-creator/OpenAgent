import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Workspace Harness packages must be bundled into main/preload (not left as
 * runtime node_modules requires) so the packaged app is self-contained and
 * every consumer shares one copy of @openagent/contracts (instanceof safety).
 * The list is derived from this package's declared dependencies, so
 * registering a new Harness in package.json bundles it automatically.
 */
const desktopPackage = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')
) as { dependencies?: Record<string, string> }
const bundledWorkspaceDeps = {
  exclude: Object.keys(desktopPackage.dependencies ?? {}).filter((name) =>
    name.startsWith('@openagent/')
  )
}

function rendererServer(): { port: number; host: string; strictPort: boolean } | undefined {
  const configured = process.env.OPENAGENT_DEV_RENDERER_PORT?.trim()
  if (!configured) return undefined
  const port = Number(configured)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`OPENAGENT_DEV_RENDERER_PORT must be a port number, got ${configured}`)
  }
  // Pin the address as well as the port: whoever waits for this port to be
  // released has to probe the same address, and an unpinned host may resolve
  // to ::1 on one machine and 127.0.0.1 on the next.
  // Fail instead of drifting to the next free port: the watcher only ever
  // probes this one, so silently incrementing would leave it observing a port
  // that nothing listens on while the renderer serves somewhere else.
  return { port, host: '127.0.0.1', strictPort: true }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: bundledWorkspaceDeps
    }
  },
  preload: {
    build: {
      externalizeDeps: bundledWorkspaceDeps
    }
  },
  renderer: {
    plugins: [react()],
    // A second dev instance (scripts/dev-main.mjs) must not fight the default
    // server for port 5173, so the address is overridable per instance.
    server: rendererServer(),
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html')
        }
      }
    },
    resolve: {
      alias: {
        'decode-named-character-reference': resolve(
          import.meta.dirname,
          'src/renderer/src/markdown/decodeNamedCharacterReference.ts'
        )
      }
    }
  }
})
