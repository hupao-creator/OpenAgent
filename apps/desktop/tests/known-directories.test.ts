import { expect, it } from 'vitest'
import { mergeKnownDirectories } from '../src/main/services/known-directories'

it('deduplicates full paths while preserving same-name workspaces and excluding temporary or invalid paths', () => {
  expect(mergeKnownDirectories([
    '/repo/a/project', '/repo/a/project/', '/repo/b/project', 'relative', '/repo/\0bad',
    '/openagent/temporary/run', '/openagent/temporary', '/openagent/temporary-sibling'
  ], '/openagent/temporary')).toEqual([
    { name: 'project', path: '/repo/a/project' }, { name: 'project', path: '/repo/b/project' },
    { name: 'temporary-sibling', path: '/openagent/temporary-sibling' }
  ])
})
