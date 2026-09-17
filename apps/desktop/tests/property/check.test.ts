import { afterEach, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { check, sequenceLength } from './check'

afterEach(() => vi.unstubAllEnvs())

it('preserves family defaults and bounds command exploration', () => {
  vi.stubEnv('FC_MAX_COMMANDS', undefined)
  expect(sequenceLength(35)).toBe(35)
  vi.stubEnv('FC_MAX_COMMANDS', '80')
  expect(sequenceLength(12)).toBe(80)
  for (const invalid of ['0', '-1', '1.5', '1001', 'NaN', '']) {
    vi.stubEnv('FC_MAX_COMMANDS', invalid)
    expect(() => sequenceLength(30)).toThrow('FC_MAX_COMMANDS must be 1..1000')
  }
})

it('retains exploration mode and generator cap in a real failure replay command', () => {
  vi.stubEnv('FC_EXPLORE', '1')
  vi.stubEnv('FC_MAX_COMMANDS', '80')
  vi.stubEnv('FC_RUNS', '1')
  vi.stubEnv('FC_SEED', '106')
  vi.stubEnv('FC_PATH', undefined)
  expect(() => check('governance replay fixture', fc.property(fc.constant(1), () => false)))
    .toThrow(/Replay: FC_EXPLORE=1 FC_MAX_COMMANDS=80 FC_RUNS=1 FC_SEED=106 FC_PATH='0'/)
})


it('honors explicit budgets without accepting interrupted or partial coverage', () => {
  vi.stubEnv('FC_EXPLORE', undefined)
  vi.stubEnv('FC_RUNS', '10')
  let samples = 0
  const property = fc.property(fc.constant(1), () => { samples++; return true })
  expect(() => check('budget fixture', property, 0)).toThrow(/"interrupted":true,"budgetMs":0/)
  expect(samples).toBe(0)
  check('budget fixture', property, 30_000)
  expect(samples).toBe(10)
})
