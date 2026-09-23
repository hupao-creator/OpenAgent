/** Shorten complete links and prose emphasis only; buffering owns the text window.
 * Keep whitespace, block markers and code literal, including unfinished fences. */
export function excerptPreview(source: string, precedingText = ''): string {
  const input = precedingText + source
  const boundary = precedingText.length
  let fence: string | undefined
  let inlineDelimiter = 0
  let result = ''
  let lineOffset = 0
  const emit = (start: number, end: number, replacement?: string): void => {
    if (end <= boundary) return
    // A window can split a delimiter or link. Scan the complete token for
    // context, but keep its visible suffix literal rather than inventing text.
    result += start < boundary ? input.slice(boundary, end) : replacement ?? input.slice(start, end)
  }
  for (const line of input.split(/(?<=\n)/)) {
    const end = lineOffset + line.length
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length &&
        /^[ \t]*$/.test(marker[2]!)) fence = undefined
      emit(lineOffset, end)
    } else if (marker && !inlineDelimiter) {
      fence = marker[1]
      emit(lineOffset, end)
    } else if (!inlineDelimiter && /^(?: {4}|\t)/.test(line)) {
      emit(lineOffset, end)
    } else {
      const proseToken = /\\[^\r\n]|`+|(?<!!)\[([^[\]\r\n]+)\]\((?:\\[^\r\n]|[^()\\\r\n]|\([^()\r\n]*\))*\)|(?<!\*)\*\*([^*`\r\n]+)\*\*(?!\*)/g
      const codeToken = /`+/g
      let offset = 0
      for (;;) {
        const pattern = inlineDelimiter ? codeToken : proseToken
        pattern.lastIndex = offset
        const token = pattern.exec(line)
        if (!token) {
          emit(lineOffset + offset, end)
          break
        }
        emit(lineOffset + offset, lineOffset + token.index)
        emit(lineOffset + token.index, lineOffset + token.index + token[0].length,
          inlineDelimiter ? undefined : token[1] ?? token[2])
        if (token[0][0] === '`') {
          if (!inlineDelimiter) inlineDelimiter = token[0].length
          else if (inlineDelimiter === token[0].length) inlineDelimiter = 0
        }
        offset = token.index + token[0].length
      }
    }
    lineOffset = end
  }
  return result
}
