import { createHash } from 'node:crypto'

/**
 * Creates a stable, bounded idempotency token without persisting a Provider's
 * native generation identity in the Core-owned telemetry sidecar.
 */
export function createOpaqueTelemetrySampleId(parts: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update('openagent.bart.telemetry.sample.v1')
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8')
    hash.update(String(bytes.byteLength))
    hash.update(':')
    hash.update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

export * from './evaluation-context.js'
export * from './provider-context.js'
export * from './evaluation-source.js'
export * from './artificial-analysis-model-facts.js'
export * from './evaluation-facts-store.js'
