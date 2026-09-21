import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4177, strictPort: true },
  resolve: {
    alias: {
      'decode-named-character-reference': resolve(
        import.meta.dirname,
        '../../src/renderer/src/markdown/decodeNamedCharacterReference.ts'
      )
    }
  },
  build: {
    outDir: resolve(import.meta.dirname, '../../out/bart-lab'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        preview: resolve(import.meta.dirname, 'preview.html'),
        transitions: resolve(import.meta.dirname, 'transitions.html'),
        generation: resolve(import.meta.dirname, 'generation.html'),
        isolation: resolve(import.meta.dirname, 'isolation.html')
      }
    }
  }
})
