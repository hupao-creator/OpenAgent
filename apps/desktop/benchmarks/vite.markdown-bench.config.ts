import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  resolve: {
    alias: {
      'decode-named-character-reference': resolve(
        import.meta.dirname,
        '../src/renderer/src/markdown/decodeNamedCharacterReference.ts'
      )
    }
  },
  build: {
    outDir: resolve(import.meta.dirname, '../out/markdown-benchmark'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'markdown-stream.html') }
  }
})
