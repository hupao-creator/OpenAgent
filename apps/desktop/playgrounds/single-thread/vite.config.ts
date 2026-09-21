import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'

const root = import.meta.dirname

// macOS keeps SF Mono inside Terminal; Chromium cannot resolve it via local().
// Expose only this installed font to the local Lab, without copying it into the build.
function labSystemFont(): Plugin {
  const path = '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/SF-Mono-Regular.otf'
  function configure(server: ViteDevServer | PreviewServer) {
    const font = existsSync(path) ? readFileSync(path) : null
    server.middlewares.use('/__lab-fonts/sf-mono-regular.otf', (_request, response) => {
      if (!font) {
        response.statusCode = 404
        response.end()
        return
      }
      response.setHeader('Content-Type', 'font/otf')
      response.end(font)
    })
  }
  return { name: 'lab-system-font', configureServer: configure, configurePreviewServer: configure }
}

export default defineConfig({
  root,
  // Keep the live preview's optimized dependencies separate from desktop tooling.
  cacheDir: resolve(root, '../../node_modules/.cache/single-thread-vite'),
  plugins: [react(), labSystemFont()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'decode-named-character-reference': resolve(
        root,
        '../../src/renderer/src/markdown/decodeNamedCharacterReference.ts'
      )
    }
  },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
  preview: { host: '127.0.0.1', port: 4178, strictPort: true },
  build: {
    outDir: resolve(root, '../../out/single-thread-playground'),
    emptyOutDir: true
  }
})
