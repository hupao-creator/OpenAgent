import { useEffect, useState } from 'react'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import type { LabConfig } from './scenarios'

// Small, uneven deltas mimic incoming text, including punctuation pauses and
// intact emoji. Keep enough text to show the latest-tail window advancing.
const DELTAS = [
  '先', '确认', '当前', '的问题', '，', '再看', '相关', '的上下文', '。',
  '这里', '需要', '沿着', '调用链', '逐步', '检查', '，', '找到', '真正', '影响', '结果', '的部分', '。',
  '我会', '先读', '现有', '实现', '，', '把', '输入', '和输出', '对应', '起来', '，',
  '再', '比较', '几种', '可能', '的处理', '方式', '。',
  'Checking ', 'the ', 'latest ', 'reasoning ', 'delta', ' 🧠', '，',
  '新文字', '正在', '持续', '进入', '，', '前面', '读过', '的内容', '逐渐', '退出', '圆弧', '。',
  '接下来', '检查', '边界', '情况', '：', '短句', '、', '标点', '和', '中英文', '混排', '。',
  '确认', '这些', '细节', '之后', '，', '就可以', '整理', '结论', '，', '给出', '清晰', '的下一步', '。'
]
const FRAMES = DELTAS.map((delta, index) => ({
  text: DELTAS.slice(0, index + 1).join(''),
  wait: index === DELTAS.length - 1 ? 2400
    : /[。！？]$/u.test(delta) ? 650 : /[，：、]$/u.test(delta) ? 360 : [130, 210, 170, 260, 150][index % 5]
}))

/** Simulate only Harness text input; the real Dock still schedules and renders it. */
export function useReasoningStream(config: LabConfig): HarnessBartActivity | null {
  const active = config.scene === 'resident' && config.variant === 'reasoning-live'
  const [step, setStep] = useState(0)
  const index = step % FRAMES.length
  const frame = FRAMES[index]
  useEffect(() => { setStep(0) }, [active, config.replay])
  useEffect(() => {
    if (!active || config.reasoningStreamPaused) return
    const wait = config.reasoningStreamBursts && index < FRAMES.length - 1 ? 150 : frame.wait
    const stride = config.reasoningStreamBursts ? Math.min(8, FRAMES.length - 1 - index) || 1 : 1
    const timer = window.setTimeout(() => setStep(current => current + stride), wait / config.reasoningStreamSpeed)
    return () => window.clearTimeout(timer)
  }, [active, step, index, frame.wait, config.reasoningStreamPaused, config.reasoningStreamSpeed, config.reasoningStreamBursts])

  return active ? {
    kind: 'reasoning', text: frame.text, sequence: step + 1, executionId: 'bart-lab-execution'
  } : null
}
