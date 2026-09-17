import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateFileAtomically } from '../main/atomic-file.js'

export const MAX_BART_EVALUATION_FACTS_BYTES = 8 * 1024 * 1024

/**
 * Current-only sidecar for Plugin-owned model evaluation evidence. Schema
 * validation stays with the acquisition service; this class only provides a
 * bounded, private, atomic JSON boundary.
 */
export class BartEvaluationFactsStore {
  readonly path: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(
      userDataPath,
      'bart-evaluation-facts.json'
    )
  }

  async load(): Promise<unknown | null> {
    let serialized: string
    try {
      const metadata = await stat(this.path)
      if (metadata.size > MAX_BART_EVALUATION_FACTS_BYTES) throw tooLargeError()
      serialized = await readFile(this.path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BART_EVALUATION_FACTS_BYTES) {
      throw tooLargeError()
    }
    let value: unknown
    try {
      value = JSON.parse(serialized) as unknown
    } catch (error) {
      throw new Error('Bart evaluation facts 不是合法 JSON', { cause: error })
    }
    assertCurrentEnvelope(value)
    return value
  }

  save(value: unknown): Promise<void> {
    try {
      assertCurrentEnvelope(value)
    } catch (error) {
      return Promise.reject(error)
    }
    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch (error) {
      return Promise.reject(new Error('Bart evaluation facts 无法序列化', { cause: error }))
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BART_EVALUATION_FACTS_BYTES) {
      return Promise.reject(tooLargeError())
    }
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => writePrivateFileAtomically(this.path, serialized))
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

function assertCurrentEnvelope(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Bart evaluation facts 不符合当前格式')
  }
  const record = value as Record<string, unknown>
  const expected = ['schemaVersion', 'source', 'observedAt', 'fetchedAt', 'configurations']
  if (Object.keys(record).length !== expected.length ||
      expected.some(key => !Object.hasOwn(record, key)) ||
      record.schemaVersion !== 1 ||
      record.source !== 'artificial-analysis' ||
      typeof record.observedAt !== 'string' ||
      typeof record.fetchedAt !== 'string' ||
      !Array.isArray(record.configurations)) {
    throw new Error('Bart evaluation facts 不符合当前格式')
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

function tooLargeError(): Error {
  return new Error(
    `Bart evaluation facts 不能超过 ${MAX_BART_EVALUATION_FACTS_BYTES} bytes`
  )
}
