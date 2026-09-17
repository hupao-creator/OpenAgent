/**
 * Main-thread Mermaid runtime.
 *
 * Each job sets the whole config it needs and renders before the next job
 * starts; `mermaid-queue` owns that serialization.
 */

import { QueueError, createMermaidQueue } from './mermaid-queue.js'

export type MermaidTheme = 'light' | 'dark'

export type MermaidFailureReason =
  | 'empty'
  | 'too-large'
  | 'external'
  | 'timeout'
  | 'load'
  | 'syntax'
  | 'render'
  | 'superseded'

export interface MermaidRenderRequest {
  /** Stable per chart slot; a newer request for the same key supersedes a queued one. */
  key: string
  source: string
  theme: MermaidTheme
  fontFamily: string
  /** Localized name for a diagram that carries no accessible title of its own. */
  label: string
}

export interface MermaidRenderResult {
  readonly svg: SVGElement
}

export class MermaidRenderError extends Error {
  readonly reason: MermaidFailureReason

  constructor(reason: MermaidFailureReason, message?: string) {
    super(message ?? reason)
    this.name = 'MermaidRenderError'
    this.reason = reason
  }
}

/** Chart text larger than this is refused before Mermaid ever parses it. */
export const MAX_MERMAID_SOURCE_LENGTH = 50_000
const MAX_MERMAID_EDGES = 500
const RENDER_TIMEOUT_MS = 10_000
/** How long the queue waits for an abandoned render before writing the runtime off. */
const SETTLE_GRACE_MS = 5_000

/**
 * Config keys that `%%{init}%%` directives and YAML frontmatter must never be
 * able to change; without this a chart could re-enable html labels or inject
 * stylesheet text from its own source.
 */
const SECURE_CONFIG_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'htmlLabels',
  'suppressErrorRendering',
  'maxTextSize',
  'maxEdges',
  'theme',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'logLevel'
]

const BLOCKED_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'image'])
/**
 * A stylesheet either reaches for something outside the chart or styles the
 * document around it. Rules are scoped by Mermaid to the chart's own id, so a
 * selector starting at the root is an escape rather than chart styling.
 */
const UNSAFE_STYLE_TEXT =
  /@import|url\(\s*['"]?(?!#)|(?:^|[},])\s*(?:html|body|:root|\*)\s*[,{]/i

/**
 * A chart may only reference its own defs. Mermaid draws markers, gradients and
 * filters as `url(#id)`, so a `url()` pointing anywhere else is a fetch — and it
 * can sit in an element's `style` attribute just as easily as in a stylesheet.
 */
const EXTERNAL_URL_VALUE = /url\(\s*['"]?(?!#)/i

/**
 * A resource object, `A@{ img: "…" }` — the only place a chart names a file
 * for Mermaid to fetch while it lays the diagram out. The field is read inside
 * those braces because the same words in a label, `A("icon: https://…")`, are
 * text: matched loosely they would refuse a diagram that never reaches out.
 * The value is captured whole because the browser strips quotes and padding
 * again before it fetches, so the check has to look at the trimmed value.
 *
 * A double-quoted run is consumed as a unit because Mermaid reads the braces in
 * one as data: `A@{ label: "}", img: "https://…" }` closes its object after the
 * image field, and stopping at the brace inside the label would leave the field
 * that actually fetches outside the text this scans. Only `"` quotes for
 * Mermaid, so a lone apostrophe stays ordinary text here too — treating it as a
 * quote would shrink the object below the one Mermaid parses.
 */
const RESOURCE_OBJECT = /@\{((?:"[^"]*"|[^"}])*)\}/g
const RESOURCE_FIELD_NAMES = new Set(['img', 'image', 'icon'])
/** Diagram types that draw themselves with icons from an online service. */
const REMOTE_DIAGRAM_TYPES = new Set(['architecture', 'architecture-beta'])

type MermaidModule = typeof import('mermaid')['default']

let importPromise: Promise<MermaidModule> | undefined
let renderSequence = 0
const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

export function renderMermaidChart(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
  if (request.source.trim() === '') return Promise.reject(new MermaidRenderError('empty'))
  if (request.source.length > MAX_MERMAID_SOURCE_LENGTH) {
    return Promise.reject(new MermaidRenderError('too-large'))
  }
  const external = findExternalResource(request.source)
  if (external !== undefined) return Promise.reject(new MermaidRenderError('external', external))
  return queue.enqueue(request.key, () => runJob(request)).then(
    (svg) => ({ svg }),
    (error: unknown) => {
      throw error instanceof QueueError ? new MermaidRenderError(error.reason, error.message) : asFailure(error)
    }
  )
}

/**
 * Gives up a request that has not started. Called when a chart unmounts: the
 * render itself cannot be cancelled once it is running, but one still waiting
 * its turn can be dropped instead of drawing a diagram nobody will see.
 */
export function cancelMermaidRender(key: string): void {
  queue.cancel(key)
}

async function runJob(request: MermaidRenderRequest): Promise<SVGElement> {
  const mermaid = await loadMermaid()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
    maxEdges: MAX_MERMAID_EDGES,
    theme: request.theme === 'dark' ? 'dark' : 'default',
    themeVariables: { background: 'transparent' },
    fontFamily: request.fontFamily,
    logLevel: 'fatal',
    secure: SECURE_CONFIG_KEYS
  })
  const id = `oa-mermaid-${(renderSequence += 1)}`
  const { svg } = await mermaid.render(id, request.source)
  return sanitizeSvg(svg, request.label)
}

function loadMermaid(): Promise<MermaidModule> {
  if (!importPromise) {
    importPromise = import('mermaid')
      .then((module) => module.default)
      .catch((error: unknown) => {
        importPromise = undefined
        throw error
      })
  }
  return importPromise
}

/**
 * The external reference a chart would fetch, or `undefined` when it stays
 * local. Only resource fields and remote icon diagrams count: a URL inside a
 * label is text, and an anchor is handled by the sanitizer.
 */
function findExternalResource(source: string): string | undefined {
  if (REMOTE_DIAGRAM_TYPES.has(declaredDiagramType(source))) {
    return '此图型需要在线图标服务'
  }
  for (const object of source.matchAll(RESOURCE_OBJECT)) {
    for (const value of declaredResourceValues(object[1])) {
      const target = value
        .trim()
        .replace(/^["']/, '')
        .replace(/["']$/, '')
        .trim()
      if (target !== '' && !target.startsWith('#') && !/^data:/i.test(target)) return target
    }
  }
  return undefined
}

/**
 * The values of the resource fields the object declares. The body is walked
 * rather than searched, because a double-quoted run is data:
 * `A@{ shape: rect, label: "See img: https://…" }` names a field in prose and
 * declares none, and reading it as a fetch would refuse a local diagram.
 */
function declaredResourceValues(body: string): string[] {
  const values: string[] = []
  let index = 0
  while (index < body.length) {
    const character = body[index]
    if (character === '"') {
      index = skipQuotedRun(body, index)
      continue
    }
    if (character === ',' || /\s/.test(character)) {
      index += 1
      continue
    }
    // A field name, up to the `:` that closes it.
    const colon = body.indexOf(':', index)
    if (colon === -1) break
    const name = body.slice(index, colon).trim().toLowerCase()
    // Its value runs to the next comma that stands outside a quoted run.
    let end = colon + 1
    while (end < body.length && body[end] !== ',') {
      end = body[end] === '"' ? skipQuotedRun(body, end) : end + 1
    }
    if (RESOURCE_FIELD_NAMES.has(name)) values.push(body.slice(colon + 1, end))
    index = end + 1
  }
  return values
}

function skipQuotedRun(text: string, open: number): number {
  const close = text.indexOf('"', open + 1)
  return close === -1 ? text.length : close + 1
}

/**
 * Mermaid strips frontmatter, directives and comments before it looks for the
 * diagram keyword, so the same text has to be stripped here. A directive is not
 * a line: `%%{\ninit: {}\n}%%` in front of an `architecture-beta` block hides
 * the keyword from a scan that only skips whole lines starting with `%%`, and
 * the skipped block is exactly the one that would go on to fetch its icons.
 */
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi
const COMMENT = /\s*%%.*\n/gm

/** The diagram keyword, ignoring frontmatter, directives and comments. */
function declaredDiagramType(source: string): string {
  const line = source
    .replace(FRONT_MATTER, '')
    .replace(DIRECTIVE, '')
    .replace(COMMENT, '\n')
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '')
  return (line ?? '').split(/\s+/)[0] ?? ''
}

/**
 * Parses Mermaid's own output and strips anything that could execute, navigate
 * or fetch: the markup is generated by the library but is still derived from
 * the message text, so it is treated as untrusted at this boundary.
 */
function sanitizeSvg(markup: string, label: string): SVGElement {
  const parsed = new DOMParser().parseFromString(markup, 'text/html')
  const svg = parsed.querySelector('svg')
  if (!svg) throw new MermaidRenderError('render', 'Mermaid returned no SVG element')
  scrub(svg)
  normalizeSize(svg)
  svg.setAttribute('role', 'img')
  nameChart(svg, label)
  return svg as unknown as SVGElement
}

/**
 * A diagram carrying `accTitle`/`accDescr` already names and describes itself;
 * leave that intact and only name the image when the source said nothing.
 */
function nameChart(svg: Element, label: string): void {
  const named =
    (svg.getAttribute('aria-label') ?? '').trim() !== '' ||
    (svg.getAttribute('aria-labelledby') ?? '').trim() !== '' ||
    (svg.querySelector(':scope > title')?.textContent ?? '').trim() !== ''
  if (!named) svg.setAttribute('aria-label', label)
}

/**
 * Mermaid sizes its output for a full-width container: `width: 100%` plus an
 * inline `max-width`. That percentage collapses against a shrink-to-fit parent,
 * so the frame is handed an explicit pixel size instead and left to scale it.
 */
function normalizeSize(svg: Element): void {
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const style = svg.getAttribute('style')
  if (style) {
    const kept = style
      .split(';')
      .filter((declaration) => !/^\s*max-width\s*:/i.test(declaration))
      .join(';')
      .trim()
    if (kept === '') svg.removeAttribute('style')
    else svg.setAttribute('style', kept)
  }
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) return
  svg.setAttribute('width', String(viewBox[2]))
  svg.setAttribute('height', String(viewBox[3]))
}

function scrub(element: Element): void {
  for (const child of Array.from(element.children)) {
    const tag = child.tagName.toLowerCase()
    if (BLOCKED_ELEMENTS.has(tag) || (tag === 'style' && UNSAFE_STYLE_TEXT.test(child.textContent ?? ''))) {
      child.remove()
      continue
    }
    scrub(child)
  }
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name)
      continue
    }
    if (name === 'href' || name === 'xlink:href' || name === 'src') {
      if (!attribute.value.trim().startsWith('#')) element.removeAttribute(attribute.name)
      continue
    }
    // `style` and `classDef` put the reference on the element rather than in a
    // stylesheet, so the same rule has to be applied to attribute values.
    if (EXTERNAL_URL_VALUE.test(attribute.value)) element.removeAttribute(attribute.name)
  }
}

function asFailure(error: unknown): MermaidRenderError {
  if (error instanceof MermaidRenderError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (isLoadFailure(error)) return new MermaidRenderError('load', message)
  return new MermaidRenderError(looksLikeSyntaxError(message) ? 'syntax' : 'render', message)
}

function isLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to fetch dynamically imported module|Cannot find module|Importing a module script failed/i.test(
    message
  )
}

function looksLikeSyntaxError(message: string): boolean {
  return /parse|syntax|lexical|expecting|invalid|unrecognized|unknown diagram|no diagram type/i.test(
    message
  )
}
