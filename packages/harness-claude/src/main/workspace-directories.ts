import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { discoverJsonlDirectories, discoveryRecord, readDiscoveryJson } from '@openagent/plugin-kit/main'
import type { HarnessProcessEnvironment } from '@openagent/contracts'

export async function discoverClaudeWorkspaceDirectories(environment: HarnessProcessEnvironment, signal: AbortSignal): Promise<string[]> {
  const root = resolve(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  const [sessions, primary, fallback] = await Promise.all([
    discoverJsonlDirectories(join(root, 'projects'), 1, signal, row => row.cwd),
    readDiscoveryJson(join(root, '.config.json')),
    readDiscoveryJson(join(environment.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'))
  ])
  signal.throwIfAborted()
  return [...new Set([...sessions, ...Object.keys(discoveryRecord(primary.projects)), ...Object.keys(discoveryRecord(fallback.projects))])]
}
