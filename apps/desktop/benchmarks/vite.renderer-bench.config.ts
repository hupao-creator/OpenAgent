import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/profiling') },
      {
        find: 'decode-named-character-reference',
        replacement: resolve(import.meta.dirname, '../src/renderer/src/markdown/decodeNamedCharacterReference.ts')
      }
    ]
  },
  build: {
    outDir: resolve(import.meta.dirname, '../out/renderer-benchmark'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'renderer.html') }
  }
})
