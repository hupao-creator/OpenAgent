import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discoverClaudeWorkspaceDirectories } from '../src/main/workspace-directories.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('discovers original paths from sessions without an index and custom-root project configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-workspaces-')); roots.push(root)
  const project = join(root, 'projects', '-ambiguous-encoded-name')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'session.jsonl'), '{}\n' + JSON.stringify({ type: 'user', cwd: '/actual/a-b/project' }) + '\n')
  await writeFile(join(project, 'broken.jsonl'), '{partial')
  await writeFile(join(root, '.claude.json'), JSON.stringify({ projects: { '/repo/config': {} } }))
  await writeFile(join(root, '.config.json'), JSON.stringify({ projects: { '/repo/primary': {} } }))
  expect((await discoverClaudeWorkspaceDirectories({ CLAUDE_CONFIG_DIR: root }, new AbortController().signal)).sort())
    .toEqual(['/actual/a-b/project', '/repo/config', '/repo/primary'])
  expect(await discoverClaudeWorkspaceDirectories({ CLAUDE_CONFIG_DIR: join(root, 'missing') }, new AbortController().signal)).toEqual([])
})
