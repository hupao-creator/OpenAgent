/**
 * Card-face command tokenizer. This is deliberately not a shell parser: it
 * recognizes only quotes, operators, flags, and segment-leading programs.
 * Every input terminates and round-trips without throwing.
 */

export type CommandTokenRole =
  | 'program'
  | 'flag'
  | 'string'
  | 'operator'
  | 'arg'
  | 'space'

export interface CommandToken {
  readonly text: string
  readonly role: CommandTokenRole
}

const MAX_LENGTH = 400
const MAX_TOKENS = 64
const OPERATORS = ['2>&1', '&&', '||', '|&', '>>', '<<', '2>', '|', ';', '>', '<', '&']
const SEGMENT_BREAKS = new Set(['&&', '||', '|&', '|', ';', '&'])

export function tokenizeCommandLine(command: string): CommandToken[] {
  if (!command || command.length > MAX_LENGTH) return [{ text: command, role: 'arg' }]
  const tokens: CommandToken[] = []
  let segmentStart = true
  let index = 0
  while (index < command.length && tokens.length < MAX_TOKENS) {
    const char = command[index]
    if (char === ' ' || char === '\t' || char === '\n') {
      const start = index
      while (index < command.length && /[ \t\n]/.test(command[index])) index += 1
      tokens.push({ text: command.slice(start, index), role: 'space' })
      continue
    }
    if (char === '"' || char === "'") {
      const start = index
      index += 1
      while (index < command.length && command[index] !== char) index += 1
      if (index < command.length) index += 1
      tokens.push({ text: command.slice(start, index), role: 'string' })
      segmentStart = false
      continue
    }
    const operator = OPERATORS.find((candidate) => command.startsWith(candidate, index))
    if (operator) {
      tokens.push({ text: operator, role: 'operator' })
      index += operator.length
      if (SEGMENT_BREAKS.has(operator)) segmentStart = true
      continue
    }
    const start = index
    while (
      index < command.length &&
      !/[ \t\n"']/.test(command[index]) &&
      !OPERATORS.some((candidate) => command.startsWith(candidate, index))
    ) {
      index += 1
    }
    const text = command.slice(start, index)
    tokens.push({
      text,
      role: text.startsWith('-') ? 'flag' : segmentStart ? 'program' : 'arg'
    })
    if (!text.startsWith('-')) segmentStart = false
  }
  if (index < command.length) tokens.push({ text: command.slice(index), role: 'arg' })
  return tokens
}
