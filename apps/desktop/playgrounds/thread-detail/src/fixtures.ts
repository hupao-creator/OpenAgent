/** Design-only fixtures. These are not a proposed Harness state or runtime contract. */
export const harnesses = [
  { id: 'codex', label: 'Codex', model: '示例模型 A' },
  { id: 'claude', label: 'Claude Code', model: '示例模型 B' }
] as const
export type PreviewHarness = (typeof harnesses)[number]
export type ThreadKind = 'agent' | 'bart'
export type Phase =
  | 'completed'
  | 'running'
  | 'approval'
  | 'question'
  | 'failed'
  | 'interrupted'
  | 'background'
  | 'empty'

export const scenarios = [
  {
    id: 'completed',
    label: '任务完成',
    description: '回复、工具、计划与文件变更',
    phase: 'completed',
    number: '01'
  },
  {
    id: 'running',
    label: '流式执行',
    description: '过程消息、增量回复与停止',
    phase: 'running',
    number: '02'
  },
  {
    id: 'approval',
    label: '等待授权',
    description: '操作范围、允许与拒绝',
    phase: 'approval',
    number: '03'
  },
  {
    id: 'question',
    label: '等待回答',
    description: '选项、补充信息与提交',
    phase: 'question',
    number: '04'
  },
  {
    id: 'failed',
    label: '执行失败',
    description: '错误原因、详情与重试',
    phase: 'failed',
    number: '05'
  },
  {
    id: 'interrupted',
    label: '已停止',
    description: '保留已有内容并继续',
    phase: 'interrupted',
    number: '06'
  },
  {
    id: 'background',
    label: '后台任务',
    description: '回复完成后仍有工作在进行',
    phase: 'background',
    number: '07'
  },
  {
    id: 'empty',
    label: '空 Thread',
    description: '首次进入与下一步操作',
    phase: 'empty',
    number: '08'
  },
  {
    id: 'history',
    label: '长历史',
    description: '160 轮、分批加载与滚动',
    phase: 'completed',
    number: '09'
  },
  {
    id: 'local-five',
    label: '真实五轮',
    description: '本机 Codex 记录 · Playground 样式迭代 · 5 轮',
    phase: 'completed',
    number: '10'
  }
] as const
export type Scenario = (typeof scenarios)[number]
export type ScenarioId = Scenario['id']

export const phaseLabels: Record<Phase, string> = {
  completed: '已完成',
  running: '执行中',
  approval: '需要授权',
  question: '需要回答',
  failed: '执行失败',
  interrupted: '已停止',
  background: '后台运行中',
  empty: '等待开始'
}

export const taskTitle = '为项目列表添加搜索与筛选'
export const prompt =
  '帮我给项目列表加一个搜索框，支持按名称搜索，也能筛选进行中和已归档的项目。延续现在的简洁样式。'
export const answer = `已添加项目搜索和状态筛选，搜索条件会保留在地址栏，刷新后仍然有效。

### 现在可以

- **按名称搜索**，忽略大小写，输入后即时更新。
- 在全部、进行中和已归档之间切换，筛选可与搜索叠加。
- 没有匹配结果时，一键清除筛选并回到完整列表。

键盘按下 \`/\` 可聚焦搜索框，\`Esc\` 清空当前搜索。

修改集中在列表页面与筛选逻辑，详情页的交互保持原样。`

export const activities = [
  {
    id: 'read',
    kind: 'read',
    label: '读取项目列表与路由',
    meta: '2 个文件',
    detail:
      'src/pages/Projects.tsx\nsrc/routes.ts\n\n列表由 ProjectList 渲染，筛选条件尚未写入 URL。'
  },
  {
    id: 'search',
    kind: 'search',
    label: '查找已有搜索与筛选组件',
    meta: '4 处匹配',
    detail:
      'rg -n "SearchInput|FilterTabs" src\n\nsrc/components/SearchInput.tsx:12\nsrc/components/FilterTabs.tsx:8\nsrc/pages/Notes.tsx:42\nsrc/pages/Archive.tsx:19'
  },
  {
    id: 'edit',
    kind: 'edit',
    label: '添加搜索和状态筛选',
    meta: '3 个文件',
    detail:
      'M src/pages/Projects.tsx\nA src/hooks/useProjectFilters.ts\nM src/styles/projects.css\n\n+86 −12'
  },
  {
    id: 'check',
    kind: 'terminal',
    label: '检查类型与构建',
    meta: '12.4 秒',
    detail:
      '$ pnpm typecheck && pnpm build\n\nTypeScript: no errors\nVite: built in 2.48s\nExit code: 0\n\n（以上是预览样例输出）'
  }
] as const

export const plan = [
  '检查现有列表与筛选入口',
  '实现搜索、状态筛选和空结果',
  '检查布局、键盘操作与构建'
]
export const changedFiles = [
  {
    path: 'src/pages/Projects.tsx',
    added: 42,
    removed: 9,
    before: 'return <ProjectList projects={projects} />',
    after:
      'const filters = useProjectFilters()\nconst visible = filterProjects(projects, filters)\nreturn <ProjectList projects={visible} />'
  },
  {
    path: 'src/hooks/useProjectFilters.ts',
    added: 31,
    removed: 0,
    before: '',
    after:
      'export function useProjectFilters() {\n  const [params, setParams] = useSearchParams()\n  const query = params.get("q") ?? ""\n  return { query, setParams }\n}'
  },
  {
    path: 'src/styles/projects.css',
    added: 13,
    removed: 3,
    before: '.project-list { padding: 24px; }',
    after:
      '.project-toolbar { display: flex; gap: 12px; }\n.project-list { padding: 24px 0; }'
  }
] as const

export const attachment = {
  name: '交互说明.md',
  content:
    '# 项目列表交互说明\n\n搜索按项目名称匹配；状态筛选包括全部、进行中、已归档。\n\n- 搜索与筛选可同时使用。\n- 搜索条件保留在 URL 中。\n- 空结果提供清除筛选入口。\n- `/` 聚焦搜索，`Esc` 清空搜索。'
}
