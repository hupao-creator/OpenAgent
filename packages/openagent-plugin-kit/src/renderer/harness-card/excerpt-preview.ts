/** Shorten complete links and prose emphasis only; buffering owns the text window.
 * Keep whitespace, block markers and code literal, including unfinished fences. */
export function excerptPreview(source: string, precedingText = ''): string {
  let fence: string | undefined
  let inlineDelimiter = 0
  const previewLine = (line: string, format: boolean): string => {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length &&
        /^[ \t]*$/.test(marker[2]!)) fence = undefined
      return line
    }
    if (marker && !inlineDelimiter) {
      fence = marker[1]
      return line
    }
    if (!inlineDelimiter && /^(?: {4}|\t)/.test(line)) return line
    // Scan context even when it is outside the visible window. Exact-length
    // backtick delimiters may close on another line or in a later text batch.
    let result = ''
    let offset = 0
    const proseToken = /\\[^\r\n]|`+|(?<!!)\[([^[\]\r\n]+)\]\((?:\\[^\r\n]|[^()\\\r\n]|\([^()\r\n]*\))*\)|(?<!\*)\*\*([^*`\r\n]+)\*\*(?!\*)/g
    const codeToken = /`+/g
    for (;;) {
      const pattern = inlineDelimiter ? codeToken : proseToken
      pattern.lastIndex = offset
      const token = pattern.exec(line)
      if (!token) return result + line.slice(offset)
      result += line.slice(offset, token.index)
      result += format && !inlineDelimiter ? token[1] ?? token[2] ?? token[0] : token[0]
      if (token[0][0] === '`') {
        if (!inlineDelimiter) inlineDelimiter = token[0].length
        else if (inlineDelimiter === token[0].length) inlineDelimiter = 0
      }
      offset = token.index + token[0].length
    }
  }
  // A streamed 600-character window can start inside a fence opened earlier.
  for (const line of precedingText.split(/(?<=\n)/)) previewLine(line, false)
  return source.split(/(?<=\n)/).map(line => previewLine(line, true)).join('')
}
