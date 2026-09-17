import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname

export default defineConfig({
  root,
  cacheDir: resolve(root, '../../node_modules/.cache/bart-thread-transition-vite'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'decode-named-character-reference': resolve(root, '../../src/renderer/src/markdown/decodeNamedCharacterReference.ts')
    }
  },
  server: { host: '127.0.0.1', port: 4181, strictPort: true },
  preview: { host: '127.0.0.1', port: 4181, strictPort: true },
  build: { outDir: resolve(root, '../../out/bart-thread-transition-playground'), emptyOutDir: true }
})
