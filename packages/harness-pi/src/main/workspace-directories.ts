import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { discoverJsonlDirectories, readDiscoveryJson } from '@openagent/plugin-kit/main'
import type { HarnessProcessEnvironment } from '@openagent/contracts'

export async function discoverPiWorkspaceDirectories(environment: HarnessProcessEnvironment, signal: AbortSignal): Promise<string[]> {
  const root = resolve(environment.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'))
  const settings = await readDiscoveryJson(join(root, 'settings.json'))
  const configured = environment.PI_CODING_AGENT_SESSION_DIR || (typeof settings.sessionDir === 'string' ? settings.sessionDir : undefined)
  const roots = new Set([join(root, 'sessions')])
  if (configured) roots.add(resolve(configured.replace(/^~(?=[/\\]|$)/, homedir())))
  const paths = await Promise.all([...roots].map(directory =>
    discoverJsonlDirectories(directory, 1, signal, row => row.type === 'session' ? row.cwd : undefined)))
  return [...new Set(paths.flat())]
}
