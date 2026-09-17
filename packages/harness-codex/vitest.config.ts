import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // Desktop ran these suites with --testTimeout=15000 before they moved here.
  test: { testTimeout: 15_000, maxWorkers: 4 }
})
