/** Shorten complete links and prose emphasis only; buffering owns the text window.
 * Keep whitespace, block markers and code literal, including unfinished fences. */
export function excerptPreview(source: string, precedingText = ''): string {
  let fence: string | undefined
  const previewLine = (line: string, format: boolean): string => {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length &&
        /^[ \t]*$/.test(marker[2]!)) fence = undefined
      return line
    }
    if (marker) {
      fence = marker[1]
      return line
    }
    if (!format || /^(?: {4}|\t)/.test(line)) return line
    // Consume code spans and escapes before considering links or **emphasis**.
    return line.replace(
      /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|\\[^\r\n]|(?<!!)\[([^[\]\r\n]+)\]\((?:\\[^\r\n]|[^()\\\r\n]|\([^()\r\n]*\))*\)|(?<!\*)\*\*([^*`\r\n]+)\*\*(?!\*)/g,
      (match: string, code: string | undefined, label: string | undefined, emphasis: string | undefined) =>
        code ? match : label ?? emphasis ?? match
    )
  }
  // A streamed 600-character window can start inside a fence opened earlier.
  for (const line of precedingText.split(/(?<=\n)/)) previewLine(line, false)
  return source.split(/(?<=\n)/).map(line => previewLine(line, true)).join('')
}
