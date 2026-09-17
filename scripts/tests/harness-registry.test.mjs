import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const registryFiles = ['harness-registry', 'harness-registry.main', 'harness-registry.renderer']
const allCapabilities = {
  instructions: true,
  threadContext: true,
  sendContext: true,
  toolModes: ['extend', 'exclusive']
}

test('aggregates native capabilities without executing process entries or exporting product policy', async (context) => {
  const descriptors = [
    { id: 'alpha', displayName: 'Alpha', threadCapabilities: allCapabilities },
    {
      id: 'beta', displayName: 'Beta',
      threadCapabilities: { instructions: false, threadContext: false, sendContext: false, toolModes: [] }
    }
  ]
  const fixture = await createFixture(context, descriptors, {
    main: "throw new Error('Main must not execute during aggregation')",
    renderer: "throw new Error('Renderer must not execute during aggregation')"
  })

  const generated = generate(fixture)
  assert.equal(generated.status, 0, generated.stderr)
  await compileGenerated(fixture)
  const registry = await import(pathToFileURL(join(fixture.generatedRoot, 'harness-registry.js')).href)
  assert.deepEqual(registry.HARNESS_IDS, ['alpha', 'beta'])
  assert.deepEqual(registry.harnessDescriptors, Object.fromEntries(descriptors.map(value => [value.id, value])))
  assert.equal(registry.harnessDisplayName('alpha'), 'Alpha')
  assert.equal(registry.harnessDisplayName('unregistered'), 'unregistered')
  assert.equal(registry.isHarnessId('unregistered'), false)
  assert.equal(Object.hasOwn(registry, 'harnessSupportsBartHost'), false)
  for (const descriptor of Object.values(registry.harnessDescriptors)) {
    assert.equal(Object.hasOwn(descriptor, 'supportsBartHost'), false)
  }
})

for (const [label, capabilities] of [
  ['missing capabilities', undefined],
  ['null capabilities', null],
  ['missing instructions', { ...allCapabilities, instructions: undefined }],
  ['nonboolean instructions', { ...allCapabilities, instructions: 'yes' }],
  ['nonboolean thread context', { ...allCapabilities, threadContext: 1 }],
  ['nonboolean send context', { ...allCapabilities, sendContext: null }],
  ['missing tool modes', { ...allCapabilities, toolModes: undefined }],
  ['nonarray tool modes', { ...allCapabilities, toolModes: 'extend' }],
  ['unknown tool mode', { ...allCapabilities, toolModes: ['replace'] }],
  ['duplicate tool mode', { ...allCapabilities, toolModes: ['extend', 'extend'] }]
]) {
  test(`rejects ${label} before touching existing registries`, async (context) => {
    const fixture = await createFixture(context, [{
      id: 'alpha', displayName: 'Alpha', threadCapabilities: capabilities
    }])
    await mkdir(fixture.generatedRoot, { recursive: true })
    for (const name of registryFiles) {
      await writeFile(join(fixture.generatedRoot, `${name}.ts`), `previous ${name}`)
    }

    const generated = generate(fixture)
    assert.notEqual(generated.status, 0)
    assert.match(generated.stderr, /有效 descriptor/)
    for (const name of registryFiles) {
      assert.equal(await readFile(join(fixture.generatedRoot, `${name}.ts`), 'utf8'), `previous ${name}`)
    }
  })
}

for (const process of ['main', 'renderer']) {
  test(`${process} registry accepts the same capabilities independent of mode order`, async (context) => {
    const descriptor = { id: 'alpha', displayName: 'Alpha', threadCapabilities: allCapabilities }
    const fixture = await createFixture(context, [descriptor], {
      [process]: processEntry({
        ...descriptor,
        threadCapabilities: { ...allCapabilities, toolModes: ['exclusive', 'extend'] }
      })
    })
    const generated = generate(fixture)
    assert.equal(generated.status, 0, generated.stderr)
    await compileGenerated(fixture)
    const registry = await import(pathToFileURL(join(fixture.generatedRoot, `harness-registry.${process}.js`)).href)
    const modules = registry[process === 'main' ? 'harnessMainPluginModules' : 'harnessRendererPluginModules']
    assert.equal(modules.length, 1)
    assert.equal(modules[0].id, 'alpha')
  })

  for (const [label, patch] of [
    ['descriptor identity', { id: 'other' }],
    ['display name', { displayName: 'Other' }],
    ['instructions', { threadCapabilities: { ...allCapabilities, instructions: false } }],
    ['thread context', { threadCapabilities: { ...allCapabilities, threadContext: false } }],
    ['send context', { threadCapabilities: { ...allCapabilities, sendContext: false } }],
    ['missing capabilities', { threadCapabilities: undefined }],
    ['missing tool modes', { threadCapabilities: { ...allCapabilities, toolModes: undefined } }],
    ['tool mode membership', { threadCapabilities: { ...allCapabilities, toolModes: ['extend', 'extend'] } }],
    ['tool mode count', { threadCapabilities: { ...allCapabilities, toolModes: ['extend'] } }]
  ]) {
    test(`${process} registry rejects mismatched ${label}`, async (context) => {
      const descriptor = { id: 'alpha', displayName: 'Alpha', threadCapabilities: allCapabilities }
      const fixture = await createFixture(context, [descriptor], {
        [process]: processEntry({ ...descriptor, ...patch })
      })
      const generated = generate(fixture)
      assert.equal(generated.status, 0, generated.stderr)
      await compileGenerated(fixture)
      await assert.rejects(
        import(pathToFileURL(join(fixture.generatedRoot, `harness-registry.${process}.js`)).href),
        new RegExp(`Harness ${process === 'main' ? 'Main' : 'Renderer'} 模块注册不匹配`)
      )
    })
  }
}

async function createFixture(context, descriptors, entries = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-harness-registry-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const desktopRoot = join(root, 'apps', 'desktop')
  const scriptsRoot = join(desktopRoot, 'scripts')
  const generatedRoot = join(desktopRoot, 'src', 'generated')
  await mkdir(scriptsRoot, { recursive: true })
  await copyFile(
    new URL('../../apps/desktop/scripts/generate-harness-registry.mjs', import.meta.url),
    join(scriptsRoot, 'generate-harness-registry.mjs')
  )
  await writeFile(join(desktopRoot, 'package.json'), JSON.stringify({
    type: 'module',
    dependencies: Object.fromEntries(descriptors.map(({ id }) => [`@openagent/harness-${id}`, 'workspace:*']))
  }))
  for (const descriptor of descriptors) {
    const packageRoot = join(desktopRoot, 'node_modules', '@openagent', `harness-${descriptor.id}`)
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: `@openagent/harness-${descriptor.id}`,
      type: 'module',
      exports: {
        './package.json': './package.json',
        ...Object.fromEntries(['manifest', 'main', 'renderer'].map(name => [`./${name}`, {
          types: `./dist/${name}.d.ts`, default: `./dist/${name}.js`
        }]))
      }
    }))
    for (const name of ['manifest', 'main', 'renderer']) {
      await writeFile(join(packageRoot, 'dist', `${name}.d.ts`), 'declare const value: unknown; export default value;')
      await writeFile(join(packageRoot, 'dist', `${name}.js`), name === 'manifest'
        ? `export default ${JSON.stringify(descriptor)}`
        : entries[name] ?? processEntry(descriptor))
    }
  }
  return { desktopRoot, generatedRoot }
}

function processEntry(descriptor) {
  return `export default ${JSON.stringify({ id: 'alpha', descriptor })}`
}

function generate(fixture) {
  return spawnSync(process.execPath, ['scripts/generate-harness-registry.mjs'], {
    cwd: fixture.desktopRoot, encoding: 'utf8'
  })
}

async function compileGenerated(fixture) {
  for (const name of registryFiles) {
    const source = await readFile(join(fixture.generatedRoot, `${name}.ts`), 'utf8')
    const compiled = stripTypeScriptTypes(source).replace("from './harness-registry'", "from './harness-registry.js'")
    await writeFile(join(fixture.generatedRoot, `${name}.js`), compiled)
  }
}
