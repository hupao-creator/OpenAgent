import fc from 'fast-check'
import { expect, it } from 'vitest'
import { JsonLines } from '@openagent/plugin-kit/main'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budget = process.env.FC_EXPLORE ? 120_000 : 30_000
// Pure in-memory framing, so the pure sample budget applies.
const samples = { normal: 100, explore: 1000 }

interface ChunkScenario {
  readonly lines: readonly string[]
  readonly eol: '\n' | '\r\n'
  readonly trailing: boolean
  readonly cuts: readonly number[]
}

/**
 * Line content is assembled from tokens so that no line starts or ends with a
 * character `String.prototype.trim` removes — `\u2028`/`\u2029` are ECMAScript
 * line terminators, so they trim too and may only appear mid-line — and never
 * ends with a bare `\r`, which an `\n` record separator would swallow. The
 * spec oracle below may then take every interior line verbatim and apply trim
 * only to the final unterminated line, without re-implementing the EOL cases
 * the implementation itself defines. Interior tokens stay free — spaces, tabs,
 * lone `\r` and the Unicode line separators included, none of which JsonLines
 * treats as a record boundary — so the framing rule "only \r\n and \n separate
 * records" is exercised, not assumed.
 */
const edgeToken = fc.constantFrom('a', '0', '"x":', '}', '中', '🙂', 'e\u0301', '\u2028x')
const interiorToken = fc.constantFrom('a', ' ', '\t', '\r', '\u2028', '\u2029', '中', '🙂', 'e\u0301', '"x":', '}')
const line = fc.tuple(edgeToken, fc.array(interiorToken, { maxLength: 5 }), edgeToken)
  .map(([head, middle, tail]) => head + middle.join('') + tail)
const lineOrEmpty = fc.oneof({ weight: 1, arbitrary: fc.constant('') }, { weight: 4, arbitrary: line })

/** Deterministic byte chunks: generated cut points, deduplicated, sorted and clamped. */
function splitBytes(buffer: Buffer, cuts: readonly number[]): Buffer[] {
  const bounds = [0, ...[...new Set(cuts)]
    .filter(cut => cut >= 1 && cut <= buffer.length - 1)
    .sort((left, right) => left - right), buffer.length]
  return bounds.slice(0, -1)
    .map((start, index) => buffer.subarray(start, bounds[index + 1]!))
    .filter(chunk => chunk.length > 0)
}

/** One full pass of the production reader: every chunk through push, then end. */
function readAll(buffer: Buffer, cuts: readonly number[]): string[] {
  const reader = new JsonLines()
  const lines: string[] = []
  for (const chunk of splitBytes(buffer, cuts)) lines.push(...reader.push(chunk))
  lines.push(...reader.end())
  return lines
}

/** Spec oracle: the stream's records with empty ones dropped; the unterminated tail is trimmed. */
function expectedLines(lines: readonly string[], trailing: boolean): string[] {
  if (trailing) return lines.filter(value => value !== '')
  const trimmed = (lines.at(-1) ?? '').trim()
  return [...lines.slice(0, -1).filter(value => value !== ''), ...(trimmed ? [trimmed] : [])]
}

const scenarioArb: fc.Arbitrary<ChunkScenario> = fc.record({
  lines: fc.array(lineOrEmpty, { maxLength: 8 }),
  eol: fc.constantFrom('\n', '\r\n' as const),
  trailing: fc.boolean(),
  // Cut positions are absolute byte offsets, clamped to the stream length.
  cuts: fc.array(fc.integer({ min: 1, max: 64 }), { maxLength: 10 })
})

it('codex JsonLines output depends only on the byte stream, never on chunk boundaries', async () => {
  await checkAsync('codex JsonLines output depends only on the byte stream, never on chunk boundaries', fc.asyncProperty(
    scenarioArb,
    async scenario => {
      const buffer = Buffer.from(scenario.lines.join(scenario.eol) + (scenario.trailing ? scenario.eol : ''), 'utf8')
      const expected = expectedLines(scenario.lines, scenario.trailing)
      // The whole-stream pass is the boundary-independent baseline and runs
      // unconditionally: a many-cut plan never has to redraw down to a single
      // chunk for the trivial framing to be seen.
      const whole = readAll(buffer, [])
      expect(whole).toEqual(expected)
      expect(readAll(buffer, scenario.cuts)).toEqual(whole)
    }
  ), 'join the generated lines into one byte stream → whole-stream pass → re-read the same bytes under a generated cut plan', budget, samples)
}, timeout)
