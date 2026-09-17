import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HARNESS_IDS, harnessDescriptors } from '../src/shared/harnesses'

const appSource = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const packagesRoot = resolve(appSource, '../../../packages')
const kitRendererRoot = resolve(packagesRoot, 'openagent-plugin-kit/src/renderer')
const concreteHarnesses = HARNESS_IDS
const concreteHarnessPattern = concreteHarnesses.map(escapeRegExp).join('|')
const displayNamePattern = Object.values(harnessDescriptors)
  .map(({ displayName }) => escapeRegExp(displayName))
  .join('|')
const coreRoots = [
  resolve(appSource, 'main'),
  resolve(appSource, 'renderer/src'),
  resolve(appSource, 'shared')
]

/**
 * Renderer Plugins live in workspace packages (packages/harness-<id>) since the
 * extraction; Core reaches them only through the code-generated registry in
 * src/generated. These guards keep that package-era boundary intact.
 */
const pluginRoots = concreteHarnesses.map((id) => ({
  id,
  root: resolve(packagesRoot, `harness-${id}/src`)
}))

describe('Renderer Plugin ownership boundaries', () => {
  it('keeps evaluation services and intermediate model generations outside Core and contracts', async () => {
    const violations: string[] = []
    for (const root of [resolve(appSource, 'main'), resolve(packagesRoot, 'openagent-contracts/src')]) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, 'utf8')
        if (/BartEvaluation|ArtificialAnalysisModelFacts|evaluationFacts|evaluationIdentities|catalogSnapshot|acquireBartEvaluationSource/.test(source)) {
          violations.push(file)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps archived implementations outside the active dependency graph', async () => {
    const archivedPattern = /harness-(?:kimi|cursor|minimax|zcode)|harnesses[\\/]/
    const violations: string[] = []
    for (const root of [...coreRoots, ...pluginRoots.map(({ root }) => root)]) {
      for (const file of await sourceFiles(root)) {
        for (const specifier of importSpecifiers(await readFile(file, 'utf8'))) {
          if (archivedPattern.test(specifier)) {
            violations.push(`${relativeSource(file)} -> ${specifier}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
    await expect(access(resolve(appSource, 'harnesses'))).rejects.toThrow()
  })

  it('keeps concrete Harness package imports inside the generated registry seam', async () => {
    const violations: string[] = []
    for (const root of coreRoots) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, 'utf8')
        for (const specifier of importSpecifiers(source)) {
          if (specifier.startsWith('@openagent/harness-')) {
            violations.push(`${relativeSource(file)} -> ${specifier}`)
          }
        }
      }
    }
    expect(violations).toEqual([])

    // Positive check: every registered Plugin is wired through both generated
    // registry slices, which are the only modules allowed to import it.
    const generatedMain = await readFile(
      resolve(appSource, 'generated/harness-registry.main.ts'), 'utf8'
    )
    const generatedRenderer = await readFile(
      resolve(appSource, 'generated/harness-registry.renderer.ts'), 'utf8'
    )
    for (const id of concreteHarnesses) {
      expect(generatedMain).toContain(`@openagent/harness-${id}/main`)
      expect(generatedRenderer).toContain(`@openagent/harness-${id}/renderer`)
    }
  })

  it('keeps Plugins independent of peers and concrete Core code', async () => {
    const violations: string[] = []
    for (const { id, root } of pluginRoots) {
      const packageRoot = resolve(root, '..')
      for (const file of await sourceFiles(root)) {
        // src/test-support is the Harness's test-only adapter: it is not part
        // of the production module set (never imported by manifest/main/
        // renderer, absent from the generated registry), so its test-only
        // dependency on @openagent/test-kit is not a production boundary.
        if (file.split(sep).includes('test-support')) continue
        const source = await readFile(file, 'utf8')
        for (const specifier of importSpecifiers(source)) {
          if (specifier.startsWith('@openagent/harness-')) {
            violations.push(`${id} imports peer ${specifier}`)
            continue
          }
          if (
            specifier.startsWith('@openagent/') &&
            !specifier.startsWith('@openagent/contracts') &&
            !specifier.startsWith('@openagent/plugin-kit')
          ) {
            violations.push(`${id} -> ${specifier}`)
            continue
          }
          const target = resolveSpecifier(file, specifier)
          if (target && !target.startsWith(`${packageRoot}${sep}`)) {
            violations.push(`${id} escapes its package: ${specifier}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps opaque sessionState and provider behavior out of Core', async () => {
    const sessionStateViolations: string[] = []
    const providerBranchViolations: string[] = []
    const providerBranch = new RegExp(
      `(?:===|!==|\\bcase)\\s*['"](?:${concreteHarnessPattern})['"]|` +
      `['"](?:${concreteHarnessPattern})['"]\\s*(?:===|!==)`
    )
    for (const root of coreRoots) {
      for (const file of await sourceFiles(root)) {
        const source = await readFile(file, 'utf8')
        const code = withoutComments(source)
        if (/\bsessionState\s*(?:\.|\[)/.test(code)) {
          sessionStateViolations.push(relativeSource(file))
        }
        if (providerBranch.test(code)) {
          providerBranchViolations.push(relativeSource(file))
        }
      }
    }
    expect(sessionStateViolations).toEqual([])
    expect(providerBranchViolations).toEqual([])
  })

  it('keeps provider CSS, assets, and copy in Renderer Plugins', async () => {
    const coreStyles = await readFile(resolve(appSource, 'renderer/src/styles.css'), 'utf8')
    const kitI18n = await readFile(resolve(kitRendererRoot, 'i18n.tsx'), 'utf8')
    const kitCardBarrel = await readFile(
      resolve(kitRendererRoot, 'harness-card/index.ts'),
      'utf8'
    )

    expect(coreStyles).not.toMatch(new RegExp(
      `provider-(?:${concreteHarnessPattern})|provider-theme-(?:${concreteHarnessPattern})|` +
      `\\.(?:${concreteHarnessPattern})-`
    ))
    expect(kitI18n).not.toMatch(new RegExp(displayNamePattern))
    expect(kitCardBarrel).not.toContain("'./follow-up-entry'")
    await expect(access(resolve(appSource, 'renderer/src/assets/codex-glyph.svg')))
      .rejects.toThrow()
    await expect(access(resolve(appSource, 'renderer/src/assets/kimi-code.svg')))
      .rejects.toThrow()

    for (const { id, root } of pluginRoots) {
      const rendererRoot = resolve(root, 'renderer')
      const css = (await Promise.all(
        (await sourceFiles(rendererRoot, ['.css'])).map((file) => readFile(file, 'utf8'))
      )).join('\n')
      expect(css).toContain(`.provider-theme-${id}`)
      expect(css).toContain(`--provider-${id}-accent`)
    }
  })

  it('does not reinterpret native dynamic Renderer copy as translation keys', async () => {
    const violations: string[] = []
    const dynamicTranslation = /(?:\b\w+\.)?t\(\s*(?:notice\.message|turn\.statusLabel|interaction\.(?:title|detail)|action\.label|question\.(?:header|prompt)|option\.(?:label|description)|projection\.(?:statusLabel|identity\.model))\s*\)/g
    const roots = [
      ...pluginRoots.map(({ root }) => resolve(root, 'renderer')),
      resolve(kitRendererRoot, 'harness-card'),
      resolve(kitRendererRoot, 'components/InteractionQuestions.tsx')
    ]
    for (const root of roots) {
      const files = extname(root) ? [root] : await sourceFiles(root)
      for (const file of files) {
        const source = withoutComments(await readFile(file, 'utf8'))
        for (const match of source.matchAll(dynamicTranslation)) {
          violations.push(`${relativeSource(file)}: ${match[0]}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

async function sourceFiles(
  root: string,
  extensions = ['.ts', '.tsx']
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path, extensions))
    else if (extensions.includes(extname(entry.name))) files.push(path)
  }
  return files
}

function importSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g),
    (match) => match[1]
  )
}

function resolveSpecifier(file: string, specifier: string): string | undefined {
  return specifier.startsWith('.')
    ? resolve(dirname(file), specifier)
    : undefined
}

function relativeSource(path: string): string {
  return path.startsWith(`${appSource}${sep}`)
    ? path.slice(appSource.length + 1)
    : path.slice(packagesRoot.length + 1)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
