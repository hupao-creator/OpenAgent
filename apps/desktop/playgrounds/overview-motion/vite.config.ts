import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname

export default defineConfig({
  root,
  cacheDir: resolve(root, '../../node_modules/.cache/overview-motion-vite'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'decode-named-character-reference': resolve(root, '../../src/renderer/src/markdown/decodeNamedCharacterReference.ts')
    }
  },
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
  preview: { host: '127.0.0.1', port: 4179, strictPort: true },
  build: { outDir: resolve(root, '../../out/overview-motion-playground'), emptyOutDir: true }
})
