import type { HarnessTranslationCatalog } from '@openagent/contracts/renderer'

/**
 * Pi-only copy. Shared vocabulary (`模型`, `重试`, `目录中不可用`, …) belongs to
 * the Kit catalog, and a key may be owned by one Harness only.
 */
export const piRendererTranslations = {
  'en-US': {
    'Pi Thread 配置': 'Pi Thread settings',
    'Pi 原生默认': 'Pi native default',
    'Pi 状态不可用': 'Pi status unavailable',
    '中断': 'Interrupt',
    '正在读取 Pi 环境…': 'Loading the Pi environment…',
    '重试中…': 'Retrying…'
  }
} as const satisfies HarnessTranslationCatalog
