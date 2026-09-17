/** The display aggregate preserves native text and inserts only missing paragraph breaks. */
export function joinCodexAssistantTexts(texts: Iterable<string>): string {
  let joined = ''
  for (const text of texts) {
    if (!text) continue
    if (joined) {
      const trailingNewlines = joined.match(/\n*$/)?.[0].length || 0
      const leadingNewlines = text.match(/^\n*/)?.[0].length || 0
      joined += '\n'.repeat(Math.max(0, 2 - trailingNewlines - leadingNewlines))
    }
    joined += text
  }
  return joined
}
