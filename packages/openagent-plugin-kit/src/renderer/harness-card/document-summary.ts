import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)
// A one-line preview must not parse megabytes of unchanged history per stream update.
// Bound both the parser input and retained cache; full content stays in the opaque row.
const summaries = new Map<string, string>()
const SUMMARY_SOURCE_LIMIT = 1024
const SUMMARY_CACHE_LIMIT = 256
/** Presentation-only Markdown conversion; the original content is never truncated. */
export function threadDocumentSummary(markdown: string): string {
  const source = markdown.slice(0, SUMMARY_SOURCE_LIMIT)
  const cached = summaries.get(source)
  if (cached !== undefined) return cached
  const text = (node: Nodes): string => {
    if (node.type === 'html' || node.type === 'definition' || node.type === 'footnoteDefinition') return ''
    if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
    if ('value' in node) return node.value
    if ('children' in node) {
      const separator = ['paragraph', 'heading', 'strong', 'emphasis', 'delete', 'link', 'linkReference'].includes(node.type) ? '' : ' '
      return node.children.map((child) => text(child)).join(separator)
    }
    return ' '
  }
  const summary = text(parser.parse(source)).replace(/\s+/g, ' ').trim()
  if (summaries.size >= SUMMARY_CACHE_LIMIT) summaries.delete(summaries.keys().next().value!)
  summaries.set(source, summary)
  return summary
}

/** Bound repeated list text, retaining the exact title for the selected document. */
export function threadDocumentHeading(title: string): { title: string; entryTitle: string } {
  const entryTitle = title.slice(0, 240).replace(/\s+/g, ' ').trim()
  return { title, entryTitle: title.length > 240 ? `${entryTitle}…` : entryTitle }
}
