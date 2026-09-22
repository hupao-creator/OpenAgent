import { useCallback, useEffect, useRef, useState } from 'react'

export const MESSAGE_BATCH_SIZE = 600
export const MESSAGE_HOLD_MS = 800

// Authored plain-text samples, so the Lab can observe the exact rendered batch.
function sampleBatch(lead: string, detail: string, size = MESSAGE_BATCH_SIZE): string {
  return Array.from(lead + detail.repeat(Math.ceil(size / Array.from(detail).length)))
    .slice(0, size).join('')
}

const samples = [
  [
    sampleBatch('**正在定位搜索入口**\n检查 `query` 字段与 [项目列表](./projects)，确认名称和描述的读取方式。\n',
      '搜索词会先去掉首尾空格，再以不区分大小写的方式匹配。空搜索词保留全部项目。列表顺序和选中状态沿用原有逻辑，输入框只影响当前可见结果。'),
    sampleBatch('筛选逻辑已经接好。现在处理输入清空、无匹配结果和缺少描述的项目。',
      '名称与描述任意一项命中就保留项目；缺少描述时使用空字符串参与匹配。清空输入后恢复完整列表，并保留原有排序。结果区域继续使用已有布局，避免搜索时改变卡片尺寸。'),
    sampleBatch('开始验证边界情况。中文、英文大小写、连续空格和空结果都已加入检查。',
      '接下来核对键盘导航与选中状态，确保搜索不会把操作焦点移出列表。测试结果会整理为独立消息。', 280)
  ].join(''),
  [
    sampleBatch('收到新的检查结果。名称与描述筛选均已通过，接下来检查键盘导航与边界输入。',
      '项目名称和描述筛选均已通过。现在重点检查搜索词变化后的选中项处理，以及项目名称包含特殊字符时的匹配结果。正常输入不需要触发网络请求，筛选直接复用已经加载的数据。'),
    sampleBatch('准备交付搜索功能。筛选、清空与空结果提示已经形成完整流程。',
      '最后复核不同列表长度下的键盘操作和焦点恢复。验证通过后整理改动范围、使用方式，以及需要关注的边界情况。', 240)
  ].join('')
].map(text => Array.from(text))

interface BufferRun {
  readonly id: number
  readonly sample: number
  readonly received: number
  readonly playing: boolean
}

/** Lab-only producer. The production excerpt owns batching, reveal and dwell. */
export function useMessageBufferDemo(sceneKey: string) {
  const sequence = useRef(0)
  const [run, setRun] = useState<BufferRun | null>(null)
  const reset = useCallback(() => setRun(null), [])
  useEffect(reset, [sceneKey, reset])
  const characters = run ? samples[run.sample]! : []
  const receiving = Boolean(run && run.received < characters.length)
  const startMessage = useCallback((sample: number) => {
    sequence.current += 1
    setRun({ id: sequence.current, sample, received: 120, playing: true })
  }, [])
  useEffect(() => {
    if (!run?.playing || !receiving) return
    const id = run.id
    const timer = setInterval(() => setRun(current => current?.id === id
      ? { ...current, received: Math.min(current.received + 240, samples[current.sample]!.length) }
      : current), 240)
    return () => clearInterval(timer)
  }, [run?.id, run?.playing, receiving])
  return {
    active: run !== null,
    content: run ? characters.slice(0, run.received).join('') : undefined,
    id: run?.id ?? 0, received: run?.received ?? 0, total: characters.length,
    playing: run?.playing ?? false,
    start: () => startMessage(0),
    toggle: () => setRun(current => current ? { ...current, playing: !current.playing } : current),
    interrupt: () => startMessage(run ? (run.sample + 1) % samples.length : 1), reset
  }
}
