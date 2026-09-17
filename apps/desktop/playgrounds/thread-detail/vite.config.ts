import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname

export default defineConfig({
  root,
  // Keep the live preview's optimized dependencies separate from desktop tooling.
  cacheDir: resolve(root, '../../node_modules/.cache/thread-detail-vite'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'decode-named-character-reference': resolve(
        root,
        '../../src/renderer/src/markdown/decodeNamedCharacterReference.ts'
      )
    }
  },
  server: { host: '127.0.0.1', port: 4176, strictPort: true },
  preview: { host: '127.0.0.1', port: 4176, strictPort: true },
  build: {
    outDir: resolve(root, '../../out/thread-detail-playground'),
    emptyOutDir: true
  }
})
