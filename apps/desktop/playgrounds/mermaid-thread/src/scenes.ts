/** Fixture Markdown for the Mermaid reading lab. Every scene is plain content
 * for the production `MarkdownBody`; nothing here reaches into renderer internals. */

export interface Scene {
  id: string
  label: string
  /** What a reader should see, shown above the message column. */
  expectation: string
  content: string
}

const FLOWCHART = '```mermaid\ngraph TD\n  A[开始] --> B{校验订单}\n  B -->|通过| C[扣减库存]\n  B -->|拒绝| D[通知用户]\n  C --> E[结束]\n```\n'
const SEQUENCE = '```mermaid\nsequenceDiagram\n  participant C as 客户端\n  participant S as 订单服务\n  participant D as 库存服务\n  C->>S: 提交订单\n  S->>D: 预占库存\n  D-->>S: 预占成功\n  S-->>C: 下单完成\n```\n'
const CLASS = '```mermaid\nclassDiagram\n  class 订单 {\n    +String 编号\n    +提交()\n    +取消()\n  }\n  class 支付 {\n    +发起()\n  }\n  订单 --> 支付 : 结算\n```\n'
const STATE = '```mermaid\nstateDiagram-v2\n  [*] --> 待支付\n  待支付 --> 已支付 : 付款\n  待支付 --> 已取消 : 超时\n  已支付 --> 已发货 : 出库\n  已发货 --> [*]\n```\n'
const ER = '```mermaid\nerDiagram\n  客户 ||--o{ 订单 : 下单\n  订单 ||--|{ 订单行 : 包含\n  订单行 }o--|| 商品 : 引用\n```\n'

/** Ordinary Markdown that must keep behaving exactly as before (A15). */
const ORDINARY = [
  '| 字段 | 含义 |',
  '| --- | --- |',
  '| 编号 | 订单主键 |',
  '',
  '见 [仓库文档](https://example.invalid/docs)，或运行 `pnpm verify`。',
  '',
  '```ts',
  'const order = await submit()',
  '```',
  ''
].join('\n')

function wideFlowchart(): string {
  const columns = 14
  const chain = Array.from({ length: columns }, (_, index) => `  N${index}[阶段 ${index + 1}]`).join(' -->\n')
  return `\`\`\`mermaid\ngraph LR\n${chain}\n\`\`\`\n`
}

/** Charts that try to escape the sanitized rendering path. Each is its own
 * fence so one refusal cannot mask another. */
const HOSTILE = [
  '```mermaid',
  'graph TD',
  '  A[入口] --> B[下单]',
  '  click A "javascript:window.__oaClicked = true"',
  '  click B href "http://evil.example/leak.png" "外链"',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A["<script>window.__oaScriptRan = true</script>"] --> B["<img src=http://evil.example/x.png onerror=\\"window.__oaImgRan = true\\">"]',
  '```',
  '',
  '```mermaid',
  '---',
  'config:',
  '  securityLevel: loose',
  '  htmlLabels: true',
  '  themeCSS: "body { display: none !important }"',
  '---',
  'graph TD',
  '  A[应当可见] --> B[也应当可见]',
  '```',
  '',
  '```mermaid',
  '%%{init: {"themeCSS": "body { display: none !important }", "securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%',
  'graph TD',
  '  A[降级尝试] --> B[仍然安全]',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A@{ img: "http://evil.example/icon.png", label: "远程图标", pos: "b", constraint: "on" }',
  '  A --> B[本地节点]',
  '```',
  '',
  '```mermaid',
  'architecture-beta',
  '  service api(cloud)[订单服务]',
  '```',
  ''
].join('\n')

const OVERSIZED = `\`\`\`mermaid\ngraph TD\n  A[超限] --> B[回退]\n%% ${'x'.repeat(50_050)}\n\`\`\`\n`

const BROKEN = '```mermaid\nthis is not a diagram\n```\n'
const EMPTY = '```mermaid\n```\n'

/** Successive full snapshots of one streaming message; content only grows. */
export const STREAM_CHUNKS = [
  '订单流程如下：\n\n```mermaid\ngraph TD\n',
  '订单流程如下：\n\n```mermaid\ngraph TD\n  A[提交] --> B[校验]\n',
  '订单流程如下：\n\n```mermaid\ngraph TD\n  A[提交] --> B[校验]\n  B --> C[入库]\n',
  '订单流程如下：\n\n```mermaid\ngraph TD\n  A[提交] --> B[校验]\n  B --> C[入库]\n```\n',
  '订单流程如下：\n\n```mermaid\ngraph TD\n  A[提交] --> B[校验]\n  B --> C[入库]\n```\n\n入库后立刻通知仓库。\n'
] as const

/** Content whose closing fence line is never newline-confirmed, so only the end
 * of the message can make it renderable. */
export const UNTERMINATED_FENCE = '```mermaid\ngraph TD\n  A[流结束才出图] --> B[完成]\n```'

export const scenes: Scene[] = [
  {
    id: 'types',
    label: '常用图型',
    expectation: '流程图、时序图、类图、状态图、ER 图都出图，中文标签完整；其后的表格、链接和代码块保持原样。',
    content: `${FLOWCHART}\n${SEQUENCE}\n${CLASS}\n${STATE}\n${ER}\n${ORDINARY}`
  },
  {
    id: 'wide',
    label: '宽图',
    expectation: '宽流程默认适配宽度；点“原始大小”后保持天然尺寸并在块内横向滚动，消息列和页面都不被撑宽。',
    content: `${wideFlowchart()}\n宽图后面还有一段普通文字。\n`
  },
  {
    id: 'multi',
    label: '同文多图',
    expectation: '六张同源图表各自出图，SVG 与内部 id 互不冲突，箭头和标签不会串图。',
    content: Array.from({ length: 6 }, () => FLOWCHART).join('\n')
  },
  {
    id: 'hostile',
    label: '恶意源码',
    expectation: '点击回调、脚本/HTML 标签、javascript: 链接、远程图片、frontmatter 与 directive 的降级尝试和 CSS 注入都不生效、不联网。',
    content: HOSTILE
  },
  {
    id: 'error',
    label: '失败隔离',
    expectation: '语法错误、空块和超限各自回退为源码并给出原因，同一消息里的正常图表不受影响。',
    content: `${BROKEN}\n${EMPTY}\n${OVERSIZED}\n${FLOWCHART}`
  },
  {
    id: 'stream',
    label: '流式与主题',
    expectation: '围栏未闭合时只显示源码；闭合行被换行确认后立即出图；尾部追加正文不重绘已完成的图。',
    content: STREAM_CHUNKS[0]
  }
]
