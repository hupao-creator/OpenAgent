import type {
  ThreadCardComponentKind,
  ThreadCardComposition,
  ThreadCardExtensionKind,
  ThreadCardExtensionPlacement,
  ThreadCardExtensionProjection,
  ThreadCardLayoutContext,
  ThreadCardPresentation,
  ThreadCardProjection,
  ThreadCardSize,
  ThreadCardSizeContract,
  ThreadCardSizeSelection,
  ThreadCardVariantId
} from './contracts.js'

const SIZE_1X1: ThreadCardSize = { cols: 1, rows: 1 }
const SIZE_2X1: ThreadCardSize = { cols: 2, rows: 1 }
const SIZE_1X2: ThreadCardSize = { cols: 1, rows: 2 }

export const THREAD_CARD_ALLOWED_SIZES: Readonly<
  Record<ThreadCardComponentKind, readonly ThreadCardSize[]>
> = {
  identity: [SIZE_1X1, SIZE_1X2],
  todo: [SIZE_1X1, SIZE_1X2],
  derived: [SIZE_1X1, SIZE_2X1, SIZE_1X2],
  permission: [SIZE_1X1],
  question: [SIZE_1X2]
}

export const THREAD_CARD_DEFAULT_PREFERRED_SIZES: Readonly<
  Record<ThreadCardComponentKind, ThreadCardSize>
> = {
  identity: SIZE_1X1,
  todo: SIZE_1X1,
  derived: SIZE_2X1,
  permission: SIZE_1X1,
  question: SIZE_1X2
}

const THREAD_CARD_CANONICAL_KINDS: readonly ThreadCardExtensionKind[] = [
  'intervention',
  'todo',
  'derived'
]

interface ExtensionContract extends ThreadCardSizeContract {
  readonly extension: ThreadCardExtensionProjection
  readonly component: Exclude<ThreadCardComponentKind, 'identity'>
}

interface Candidate {
  readonly size: ThreadCardSize
  readonly identity: ThreadCardSizeSelection
  readonly placements: readonly ThreadCardExtensionPlacement[]
  readonly rank: readonly number[]
  readonly key: string
}

export function threadCardSizeContract(
  component: ThreadCardComponentKind
): ThreadCardSizeContract {
  const preferredSize = THREAD_CARD_DEFAULT_PREFERRED_SIZES[component]
  const allowedSizes = THREAD_CARD_ALLOWED_SIZES[component]
  if (!allowedSizes.some((allowed) => sameSize(allowed, preferredSize))) {
    throw new Error(
      `Thread card preferred size ${sizeKey(preferredSize)} is not allowed for ${component}`
    )
  }
  return { component, allowedSizes, preferredSize }
}

export function threadCardExtensionComponent(
  extension: ThreadCardExtensionProjection
): Exclude<ThreadCardComponentKind, 'identity'> {
  if (extension.kind !== 'intervention') return extension.kind
  return extension.intervention.questions?.length ? 'question' : 'permission'
}

function threadCardExtensionSizeContract(
  extension: ThreadCardExtensionProjection
): ExtensionContract {
  const component = threadCardExtensionComponent(extension)
  return {
    ...threadCardSizeContract(component),
    extension,
    component
  }
}

/**
 * Deterministic exhaustive Composer copied from the historical card system.
 * It sees only component size contracts and geometry. Candidate order is
 * lexicographic: column overflow, unmet non-Derived preferences, portrait
 * orientation, area, Identity growth, unmet Derived preferences, stable key.
 */
export function composeThreadCard(
  projection: ThreadCardProjection,
  layoutContext: ThreadCardLayoutContext
): ThreadCardPresentation {
  if (projection.kind === 'dynamic-workflow') {
    const composition: ThreadCardComposition = {
      kind: 'dynamic-workflow',
      size: { cols: 2, rows: 2 },
      key: 'dynamic-workflow:2x2'
    }
    return {
      projection,
      composition,
      size: composition.size,
      key: composition.key
    }
  }

  if (layoutContext.displayPolicy?.hideInterventions) {
    projection = {
      ...projection,
      extensions: projection.extensions.filter((extension) => extension.kind !== 'intervention')
    }
  }

  const extensions = canonicalExtensions(projection.extensions).map((extension) =>
    threadCardExtensionSizeContract(extension)
  )
  const identityContract = threadCardSizeContract('identity')
  if (!extensions.length) {
    const identity: ThreadCardSizeSelection = {
      ...identityContract,
      selectedSize: identityContract.preferredSize
    }
    const composition: ThreadCardComposition = {
      kind: 'standard',
      size: identity.selectedSize,
      identity,
      placements: [],
      key: 'identity:1x1'
    }
    return { projection, composition, size: composition.size, key: composition.key }
  }

  const availableCols = positiveInteger(layoutContext.availableCols)
  let best: Candidate | undefined
  for (const identitySize of identityContract.allowedSizes) {
    const identity: ThreadCardSizeSelection = {
      ...identityContract,
      selectedSize: identitySize
    }
    for (const selection of sizeSelections(extensions)) {
      const totalArea = area(identitySize) + selection.reduce(
        (sum, selected) => sum + area(selected.selectedSize),
        0
      )
      for (let cols = 1; cols <= totalArea; cols += 1) {
        if (totalArea % cols !== 0) continue
        const rows = totalArea / cols
        // A single-column viewport must be able to stack every extension.
        if (Math.abs(cols - rows) > 1 && !(availableCols === 1 && cols === 1)) continue
        if (identitySize.cols > cols || identitySize.rows > rows) continue
        for (const placements of enumeratePlacements(selection, cols, rows, identitySize)) {
          const size = { cols, rows }
          const key = candidateKey(size, identity, placements)
          const candidate: Candidate = {
            size,
            identity,
            placements,
            rank: candidateRank(placements, size, identity, availableCols),
            key
          }
          if (!best || compareCandidates(candidate, best) < 0) best = candidate
        }
      }
    }
  }

  if (!best) throw new Error('Thread card composer failed to produce a complete rectangle')
  const composition: ThreadCardComposition = {
    kind: 'standard',
    size: best.size,
    identity: best.identity,
    placements: best.placements,
    key: `standard:${best.key}`
  }
  return { projection, composition, size: composition.size, key: composition.key }
}

function canonicalExtensions(
  extensions: readonly ThreadCardExtensionProjection[]
): ThreadCardExtensionProjection[] {
  const byKind = new Map(extensions.map((extension) => [extension.kind, extension]))
  return THREAD_CARD_CANONICAL_KINDS.flatMap((kind) => {
    const extension = byKind.get(kind)
    return extension ? [extension] : []
  })
}

function sizeSelections(extensions: readonly ExtensionContract[]): Array<Array<{
  readonly contract: ExtensionContract
  readonly selectedSize: ThreadCardSize
}>> {
  let selections: Array<Array<{
    readonly contract: ExtensionContract
    readonly selectedSize: ThreadCardSize
  }>> = [[]]
  for (const contract of extensions) {
    selections = selections.flatMap((selection) =>
      contract.allowedSizes.map((selectedSize) => [...selection, { contract, selectedSize }])
    )
  }
  return selections
}

function enumeratePlacements(
  selection: Array<{ readonly contract: ExtensionContract; readonly selectedSize: ThreadCardSize }>,
  cols: number,
  rows: number,
  identitySize: ThreadCardSize
): ThreadCardExtensionPlacement[][] {
  const occupied = new Set<string>(rectangleCells(0, 0, identitySize.cols, identitySize.rows))
  const result: ThreadCardExtensionPlacement[][] = []
  const current: ThreadCardExtensionPlacement[] = []
  const place = (index: number): void => {
    if (index === selection.length) {
      result.push(current.map((placement) => ({ ...placement })))
      return
    }
    const { contract, selectedSize } = selection[index]
    for (let row = 0; row <= rows - selectedSize.rows; row += 1) {
      for (let col = 0; col <= cols - selectedSize.cols; col += 1) {
        const cells = rectangleCells(col, row, selectedSize.cols, selectedSize.rows)
        if (cells.some((cell) => occupied.has(cell))) continue
        for (const cell of cells) occupied.add(cell)
        current.push({
          kind: contract.extension.kind,
          component: contract.component,
          variant: variantFor(selectedSize),
          col,
          row,
          allowedSizes: contract.allowedSizes,
          preferredSize: contract.preferredSize,
          selectedSize
        })
        place(index + 1)
        current.pop()
        for (const cell of cells) occupied.delete(cell)
      }
    }
  }
  place(0)
  return result
}

function candidateRank(
  placements: readonly ThreadCardExtensionPlacement[],
  size: ThreadCardSize,
  identity: ThreadCardSizeSelection,
  availableCols: number
): readonly number[] {
  const horizontalOverflow = Math.max(0, size.cols - availableCols)
  const unmetPrimaryPreferences = placements.filter(
    (placement) => placement.component !== 'derived' &&
      !sameSize(placement.selectedSize, placement.preferredSize)
  ).length
  const unmetDerivedPreferences = placements.filter(
    (placement) => placement.component === 'derived' &&
      !sameSize(placement.selectedSize, placement.preferredSize)
  ).length
  const portraitOrientation = size.rows > size.cols ? 1 : 0
  const identityGrowth = area(identity.selectedSize) - area(identity.preferredSize)
  return [
    horizontalOverflow,
    unmetPrimaryPreferences,
    portraitOrientation,
    area(size),
    identityGrowth,
    unmetDerivedPreferences
  ]
}

function compareCandidates(left: Candidate, right: Candidate): number {
  for (let index = 0; index < left.rank.length; index += 1) {
    const difference = left.rank[index] - right.rank[index]
    if (difference !== 0) return difference
  }
  return left.key.localeCompare(right.key)
}

function rectangleCells(col: number, row: number, cols: number, rows: number): string[] {
  const cells: string[] = []
  for (let y = row; y < row + rows; y += 1) {
    for (let x = col; x < col + cols; x += 1) cells.push(`${x}:${y}`)
  }
  return cells
}

function candidateKey(
  size: ThreadCardSize,
  identity: ThreadCardSizeSelection,
  placements: readonly ThreadCardExtensionPlacement[]
): string {
  return `${sizeKey(size)}:identity.${sizeKey(identity.selectedSize)}:` + placements
    .map((placement) =>
      `${placement.component}.${placement.variant}@${placement.col},${placement.row},${sizeKey(placement.selectedSize)}`
    )
    .join('|')
}

function variantFor(size: ThreadCardSize): ThreadCardVariantId {
  if (size.rows > 1) return 'tall'
  if (size.cols > 1) return 'wide'
  return 'compact'
}

function area(size: ThreadCardSize): number {
  return size.cols * size.rows
}

function sameSize(left: ThreadCardSize, right: ThreadCardSize): boolean {
  return left.cols === right.cols && left.rows === right.rows
}

function sizeKey(size: ThreadCardSize): string {
  return `${size.cols}x${size.rows}`
}

function positiveInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}
