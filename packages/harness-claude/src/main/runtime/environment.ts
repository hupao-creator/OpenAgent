import { debugEnvironmentSummary, debugError, startDebugSpan } from '../debug.js'
import { type ClaudeMainContext } from '../types.js'
import { abortable } from './cancellation.js'
export async function resolveClaudeEnvironment(
  context: ClaudeMainContext,
  cwd: string,
  configuredPath: string | undefined,
  signal: AbortSignal,
  purpose: string
): Promise<{ executable: string; environment: NodeJS.ProcessEnv }> {
  const span = startDebugSpan('claude.resolve-environment', {
    harnessId: 'claude',
    purpose,
    cwd,
    ...(configuredPath ? { configuredPath } : {})
  })
  try {
    const [executable, environment] = await abortable(
      Promise.all([
        context.resolveExecutable(cwd, configuredPath),
        context.environment()
      ]),
      signal
    )
    span.end({ executable, ...debugEnvironmentSummary(environment) })
    return { executable, environment }
  } catch (error) {
    span.fail(error)
    debugError('claude.resolve-environment.error', error, {
      harnessId: 'claude',
      purpose,
      cwd
    })
    throw error
  }
}
