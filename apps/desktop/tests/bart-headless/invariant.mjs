import assert, { AssertionError } from 'node:assert/strict'

// IDs describe the oracle, not its source location. Keep them stable when code
// moves, and give distinct assertions distinct IDs.
export const check = Object.fromEntries(
  ['ok', 'equal', 'notEqual', 'deepEqual', 'doesNotMatch', 'match', 'fail'].map(method => [
    method,
    (id, ...args) => {
      try { return assert[method](...args) } catch (error) {
        if (error instanceof AssertionError) error.invariantId ??= id
        throw error
      }
    }
  ])
)

/** Give a shared oracle's assertion (or explicitly expected I/O error) an ID. */
export async function checkOperation(id, operation, expectedCodes = []) {
  try { return await operation() } catch (error) {
    if (error instanceof AssertionError || (error instanceof Error && expectedCodes.includes(error.code))) error.invariantId ??= id
    throw error
  }
}
