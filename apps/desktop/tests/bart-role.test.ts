import { describe, expect, it } from 'vitest'
import { MAX_BART_REASONING_TAIL_POINTS } from '@openagent/contracts/renderer'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { resolveBartRole } from '../src/renderer/src/bart-role'

function reasoning(text: string, sequence = 1): HarnessBartActivity {
  return { kind: 'reasoning', text, sequence, executionId: 'execution-1' }
}

describe('Bart Dock role resolution', () => {
  it('stays resident without a foreground activity', () => {
    expect(resolveBartRole(null, false)).toEqual({ kind: 'idle' })
    expect(resolveBartRole(undefined, false).kind).toBe('idle')
  })

  it('keeps mid-stream assistant text resident, with no coloured status dot', () => {
    const activity: HarnessBartActivity = { kind: 'assistant-text', sequence: 3, executionId: 'execution-1' }
    expect(resolveBartRole(activity, false).kind).toBe('idle')
  })

  it('paints the reasoning arc from a bounded, whitespace-collapsed tail', () => {
    const role = resolveBartRole(reasoning('  先看\n\n调用链   再决定  '), false)
    expect(role).toEqual({ kind: 'reasoning', text: '先看 调用链 再决定' })
  })

  it('keeps the attentive shape when a reasoning signal carries no displayable text', () => {
    expect(resolveBartRole(reasoning(''), false)).toEqual({ kind: 'reasoning', text: '' })
  })

  it('retains the source budget for width-based clipping and never splits a code point', () => {
    const long = '推'.repeat(MAX_BART_REASONING_TAIL_POINTS + 40)
    const role = resolveBartRole(reasoning(long), false)
    const text = role.kind === 'reasoning' ? role.text : ''
    expect([...text].length).toBe(MAX_BART_REASONING_TAIL_POINTS)
    expect(text).toBe('推'.repeat(MAX_BART_REASONING_TAIL_POINTS))

    // The tail counts code points, so a surrogate pair is one of them and
    // never arrives halved.
    const wide = '🧠'.repeat(MAX_BART_REASONING_TAIL_POINTS + 5)
    const wideRole = resolveBartRole(reasoning(wide), false)
    expect(wideRole.kind === 'reasoning' ? wideRole.text : '').toBe('🧠'.repeat(MAX_BART_REASONING_TAIL_POINTS))
  })

  it('shows the generic tool signature for a call without a dedicated route', () => {
    const activity: HarnessBartActivity = {
      kind: 'tool-call',
      callId: 'call-1',
      toolName: 'mcp__github__create_issue',
      sequence: 4,
      executionId: 'execution-1'
    }
    expect(resolveBartRole(activity, false)).toEqual({
      kind: 'tool', toolName: 'mcp__github__create_issue'
    })
  })

  it.each([
    'openagent_thread_list',
    'openagent_thread_start',
    'openagent_thread_send',
    'openagent_thread_respond',
    'openagent_thread_read',
    'openagent_thread_status',
    'openagent_thread_interrupt',
    'openagent_thread_delete'
  ])('defers to the dedicated choreography of %s', (toolName) => {
    const activity: HarnessBartActivity = {
      kind: 'tool-call',
      callId: 'call-1',
      toolName,
      sequence: 2,
      executionId: 'execution-1'
    }
    expect(resolveBartRole(activity, false).kind).toBe('idle')
  })

  it('defers to a running dedicated route even for a fallback call or reasoning', () => {
    expect(resolveBartRole(reasoning('想'), true).kind).toBe('idle')
  })

  it('keeps the same display role across equal-text segments', () => {
    expect(resolveBartRole(reasoning('想', 1), false)).toEqual(
      resolveBartRole(reasoning('想', 2), false)
    )
  })
})
