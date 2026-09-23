# 新建 Harness Plugin：从空目录到可验证的 Thread

本教程面向开发者和 coding agent，适用于**仓库内**新增
`packages/harness-<id>/`。先在独立开发 checkout 走通下列 `demo` 示例，再替换
native adapter。它是确定性的教学 Harness，不调用模型，也不是新增受支持的 runtime、
外部分发协议或脚手架。不要把示例的能力声明当作实际 CLI 已支持的能力。

权威规则仍在[包结构与注册](README.md)、[Main module](openagent-contracts/src/harness-module.ts)、
[Thread/settings](openagent-contracts/src/harness-plugin.ts)、
[Renderer module](openagent-contracts/src/renderer/harness-module.ts) 和
[Renderer plugin](openagent-contracts/src/renderer/harness-plugin.ts)。遇到版本差异先核对这些文件。

## 1. 准备包和构建入口

从仓库根目录执行。先按 [Desktop 构建指南](../apps/desktop/BUILDING.md) 准备
Node、pnpm 和 Electron。使用新 id 时，将以下所有 `demo` 一起替换。

```sh
mkdir -p packages/harness-demo/src/{shared,main/thread,renderer}
```

最小目录树（真实 native I/O 后续放 `main/runtime/`）：

```text
packages/harness-demo/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── index.ts
    ├── manifest.ts
    ├── shared/descriptor.ts
    ├── shared/state.ts
    ├── main/entry.ts
    ├── main/thread/handle.ts
    └── renderer/
        ├── entry.tsx
        ├── demo.css
        └── assets.d.ts
```

以下带路径的代码块是完整文件，可以逐个保存。

### `packages/harness-demo/package.json`

```json
{
  "name": "@openagent/harness-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./manifest": { "types": "./dist/manifest.d.ts", "default": "./dist/manifest.js" },
    "./main": { "types": "./dist/main/entry.d.ts", "default": "./dist/main/entry.js" },
    "./renderer": { "types": "./dist/renderer/entry.d.ts", "default": "./dist/renderer/entry.js" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node -e \"fs.cpSync('src/renderer/demo.css', 'dist/renderer/demo.css')\"",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@openagent/contracts": "workspace:*",
    "@openagent/plugin-kit": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0" },
  "devDependencies": { "@types/react": "^19.1.12", "react": "^19.2.8", "typescript": "^7.0.2" }
}
```

### `packages/harness-demo/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "jsx": "react-jsx", "lib": ["ES2023", "DOM"],
    "strict": true, "skipLibCheck": true, "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

### `packages/harness-demo/tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false, "composite": true, "declaration": true,
    "outDir": "./dist", "rootDir": "./src",
    "tsBuildInfoFile": "./node_modules/.cache/tsconfig.build.tsbuildinfo"
  }
}
```

### `packages/harness-demo/src/shared/descriptor.ts`

```ts
import type { HarnessPluginDescriptor } from '@openagent/contracts'
export const descriptor = {
  id: 'demo', displayName: 'Demo (tutorial)',
  threadCapabilities: {
    instructions: false, threadContext: false, sendContext: false, toolModes: []
  }
} satisfies HarnessPluginDescriptor<'demo'>
```

### `packages/harness-demo/src/manifest.ts`

```ts
export { descriptor as default } from './shared/descriptor.js'
```

### `packages/harness-demo/src/index.ts`

```ts
export { descriptor } from './shared/descriptor.js'
export { stateOf } from './shared/state.js'
```

`id` 必须匹配 `@openagent/harness-<id>` 后缀，以小写字母开头，后接小写字母、
数字或连字符。manifest 默认导出唯一 descriptor；`.` 和 manifest 都不得引入
Main、Renderer 或 I/O。Main 和 Renderer 的默认导出同样使用这份 descriptor。

## 2. 定义自己的 durable state

### `packages/harness-demo/src/shared/state.ts`

```ts
import type { DeepReadonly, JsonValue, PublicExecution } from '@openagent/contracts'
export type DemoState = {
  messages: string[]
  execution: PublicExecution | null
}
export function stateOf(value: DeepReadonly<JsonValue>): DemoState {
  // 本例只接收本插件自己提交的当前版本数据；真实 adapter 应验证自己的 payload。
  return value === null ? { messages: [], execution: null }
    : structuredClone(value) as unknown as DemoState
}
```

状态内容、native session/checkpoint id、历史 Execution 和时间戳归 Harness。
示例只保存最近 Execution；正式插件需要保留并解析自己的历史 Execution，供
Report/历史阅读定位使用。Core 只持久化 opaque JSON，不能靠解析字段推断状态。
`project` 和 `settle` 不能启动进程、读时钟或依赖上一次 observation。

## 3. 实现一个 Handle owner

### `packages/harness-demo/src/main/thread/handle.ts`

```ts
import type {
  HarnessThreadOpenContext, HarnessThreadHandle, JsonValue
} from '@openagent/contracts'
import { stateOf, type DemoState } from '../../shared/state.js'

export async function openDemoThread(context: HarnessThreadOpenContext): Promise<HarnessThreadHandle> {
  let disposed = false
  let queue: Promise<void> = Promise.resolve()
  const serialize = (work: () => Promise<void>) => {
    const next = queue.then(work)
    queue = next.catch(() => {})
    return next
  }
  const publish = (state: DemoState) => context.sessionState.commit(state as unknown as JsonValue)
  const assertOpen = () => {
    if (disposed || context.signal.aborted) throw new Error('Handle closed')
  }
  const finish = async (status: 'completed' | 'interrupted') => {
    const state = stateOf(context.sessionState.read())
    const execution = state.execution
    if (!execution || !['running', 'waiting-for-user'].includes(execution.status)) return
    state.execution = { executionId: execution.executionId, startedAt: execution.startedAt,
      status, finishedAt: Date.now() }
    await publish(state)
  }
  return {
    send: request => serialize(async () => {
      assertOpen()
      request.signal.throwIfAborted()
      if (request.contextEntries?.length) throw new Error('Demo does not support send context')
      if (request.input.parts.some(part => part.kind !== 'text')) throw new Error('Demo accepts text only')
      const text = request.input.parts.map(part => part.kind === 'text' ? part.text : '').join('\n')
      const state = stateOf(context.sessionState.read())
      if (state.execution && ['running', 'waiting-for-user'].includes(state.execution.status)) {
        throw new Error('Execution already active')
      }
      state.messages.push(`You: ${text}`)
      state.execution = { executionId: request.executionId, startedAt: Date.now(), status: 'running' }
      await publish(state)
      // 两次提交演示增量发布；真实流式事件也必须逐次 await commit。
      state.messages.push('Demo: ')
      await publish(state)
      state.messages[state.messages.length - 1] += text
      if (text === '/wait') {
        state.execution = { ...state.execution, status: 'waiting-for-user', interactions: [{
          id: `${request.executionId}:confirm`, kind: 'permission', title: 'Continue demo?',
          actions: [{ id: 'allow', intent: 'allow', label: 'Continue' }], questions: []
        }] }
      }
      await publish(state)
      // /hold 保持 running，供手动测试 interrupt。没有 timer 或后台 native 工作。
      if (text !== '/wait' && text !== '/hold') await finish('completed')
    }),
    respond: request => serialize(async () => {
      assertOpen()
      const state = stateOf(context.sessionState.read())
      const execution = state.execution
      if (execution?.status !== 'waiting-for-user' ||
          execution.interactions[0].id !== request.interactionId || request.actionId !== 'allow') {
        throw new Error('Unknown or stale response')
      }
      state.messages.push('Demo: continued')
      await publish(state)
      await finish('completed')
    }),
    interrupt: () => serialize(() => finish('interrupted')),
    read: async (_question, signal) => {
      assertOpen(); signal.throwIfAborted()
      return stateOf(context.sessionState.read()).messages.join('\n')
    },
    dispose: () => serialize(async () => { disposed = true })
  }
}
```

这是无 native 资源的可运行适配器。`openThread` 不发送首条输入；Host 为一个打开的
Thread 维护一个进程内 Handle，`send/respond/interrupt/read/dispose` 都是必需方法。
它可以在 `send` 返回后继续处于等待用户状态。Renderer 的 respond 和 interrupt
通过 Host 的现有 action 回到同一个 Handle，不能另建 Renderer runtime。

接入真实 CLI 时，在 `main/runtime/` 实现进程/SDK 连接、鉴权、协议事件转换、附件、
native permissions/questions、abort 和资源关闭，再由此 Handle 独占调用。
串行化状态提交，但不要让等待模型结束的长任务堵住 interrupt/respond；等待 native
事件应可取消，并在关闭时 drain。处理 request.signal 和 context.signal，退订监听、
停止子进程、释放 tool bridge。失败和中断必须提交终态；不要把进程退出直接当作成功。
`dispose` 负责资源，Host 清理通过纯 `settle` 收敛状态，不能删除整个 Session 后台事实。

重新打开时从 `context.sessionState.read()` 恢复 native session/history；先重建连接与
交互映射，再接受命令。不要重放已完成输入。示例没有外部连接，只读取已提交的消息，
其 waiting interaction 也可由新 Handle 响应。真实中断恢复策略由 native 能力决定。
参考 [Codex Handle](harness-codex/src/main/thread/thread-handle.ts)。

后台/自发 native 工作必须先 `context.executionClaims.claim()` 获得 Core Execution id，
提交私有输入及其 `running` observation，再 `await context.executionAdmission.admit(id)`，
最后才开始或恢复 native I/O。未消费 claim 在失败时 abandon；失败 admission 不得继续 I/O。
普通 Service send 已有 `request.executionId`，不要再 claim。后台事实由 owning Harness
投影为 `backgroundWork`，与最近 Execution 独立。参见
[生命周期与 admission 回归](../apps/desktop/tests/harness-thread-runtime.test.ts)。

## 4. 组合 Main module 和统一设置

### `packages/harness-demo/src/main/entry.ts`

```ts
import type { HarnessMainPluginModule, JsonValue } from '@openagent/contracts'
import { descriptor } from '../shared/descriptor.js'
import { stateOf } from '../shared/state.js'
import { openDemoThread } from './thread/handle.js'
type Empty = Record<string, never>
const module: HarnessMainPluginModule<'demo', Empty, Empty, Empty, Empty, Empty, Empty> = {
  id: 'demo', descriptor, defaultHarnessSettings: {},
  createMainPlugin: () => ({
    // 教学 adapter 无安装项、无模型依赖，因此这两个结果不同且合理。
    detectInstallation: async () => ({ status: 'missing' }),
    availability: { probe: async () => ({ available: true }) },
    sessionState: {
      project: value => ({ latestExecution: stateOf(value).execution, backgroundWork: null }),
      resolveExecution: (value, id) => {
        const execution = stateOf(value).execution
        return execution?.executionId === id ? execution : null
      },
      settle: ({ sessionState, executionId, outcome, finishedAt }) => {
        const state = stateOf(sessionState)
        const execution = state.execution
        if (execution?.executionId === executionId &&
            ['running', 'waiting-for-user'].includes(execution.status)) {
          state.execution = { executionId, startedAt: execution.startedAt, status: outcome, finishedAt }
        }
        return state as unknown as JsonValue
      }
    },
    openThread: async context => {
      if (context.injection) throw new Error('Demo does not support injection')
      return openDemoThread(context)
    },
    prompt: { complete: async () => { throw new Error('Demo has no metadata model; implement native completion') } },
    settings: {
      normalizeHarnessSettings: () => ({}),
      describe: async () => ({ type: 'object', properties: {}, additionalProperties: false }),
      defaultThreadSettings: () => ({}),
      resolveThreadSettings: async ({ merged, requested }) => {
        if (Object.keys(merged).length || Object.keys(requested ?? {}).length) throw new Error('Unknown demo settings')
        return {}
      },
      hasThreadContent: value => stateOf(value).messages.length > 0,
      applyThreadSettingsUpdate: async ({ update }) => {
        if (Object.keys(update).length) throw new Error('Unknown demo settings')
        return {}
      },
      promptSettings: () => ({})
    },
    settingsPresentation: { load: async () => ({}) }
  })
}
export default module
```

必需 surface 是 module 的 `id/descriptor/defaultHarnessSettings/createMainPlugin`，
bundle 的 `availability`、`detectInstallation`、`sessionState` 三个方法、`openThread`、
`prompt.complete`、`settings` 七个方法和 `settingsPresentation.load`。示例有意显式拒绝
metadata prompt；正式接入必须实现 native completion 的 text/json_schema 输出、取消与
finishReason，不能把 echo 充当模型。自动标题等能力需要这一方法，普通演示回复不需要。

安装检测只检测标准 CLI 是否存在，不能读取自定义路径或调用模型。运行可用性 probe
单独判断配置路径、启动、认证等实际条件，不能依赖 settings presentation 或加载模型目录。
使用 `createMainPlugin(context)` 的 `resolveExecutable(command, cwd, configuredPath)`、
`environment()`、`providers` 和插件专属数据根；不要在 Plugin Kit 偷读 `.env`
或自行选择全局 provider。`install?` 是可选官方安装器能力。

真实设置流程：shared 保存 HarnessSettings、ThreadSettings/request/update、PromptSettings
类型；Main `settings.describe` 返回 native 字段及合法选择，`defaultThreadSettings` 提供
默认值，`resolveThreadSettings` 统一规范化、合并及验证 GUI/Bart 的创建请求；
`applyThreadSettingsUpdate` 处理当前设置、默认值与更新，并依据 `hasContent` 限制变更。
`hasThreadContent` 是纯内容事实，空 envelope 不算内容，流式文本变化不能改变该事实。
`promptSettings` 保留来源 Thread 的模型和可执行路径。
`settingsPresentation.load` 为 Renderer 提供展示数据，不能成为运行可用性的前置步骤。
Core 仅组合 task/workspace/schedule 字段，不新增 Bart 专用 native 解析器。

参考 [Codex 设置 schema](harness-codex/src/main/settings-schema.ts) 和
[Claude Main module](harness-claude/src/main/module.ts)。

## 5. 连接 Renderer

### `packages/harness-demo/src/renderer/entry.tsx`

```tsx
import './demo.css'
import type { HarnessRendererPluginModule } from '@openagent/contracts/renderer'
import { descriptor } from '../shared/descriptor.js'
import { stateOf } from '../shared/state.js'
type Empty = Record<string, never>
const module: HarnessRendererPluginModule<'demo', string, Empty, Empty, Empty> = {
  id: 'demo', descriptor,
  plugin: {
    logoSource: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Ctext y="24"%3ED%3C/text%3E%3C/svg%3E',
    ThreadView: ({ thread, actions }) => {
      const state = stateOf(thread.sessionState)
      const execution = state.execution
      return <section className="provider-theme-demo">
        <pre>{state.messages.join('\n')}</pre>
        {execution?.status === 'waiting-for-user' && <button onClick={() => void actions.respond({
          interactionId: execution.interactions[0].id, actionId: 'allow'
        })}>Continue demo</button>}
        {(execution?.status === 'running' || execution?.status === 'waiting-for-user') &&
          <button onClick={() => void actions.interrupt()}>Interrupt demo</button>}
      </section>
    },
    OverviewCard: {
      project: ({ thread }) => {
        const text = stateOf(thread.sessionState).messages.at(-1) ?? 'Empty demo'
        return { footprint: { columns: 1, rows: 1 }, structureKey: 'demo', excerpt: text, view: text }
      },
      Card: ({ projection, actions }) => <button onClick={actions.openThread}>{projection}</button>
    },
    ThreadSettings: () => <p>No native options in the tutorial.</p>,
    HarnessSettings: () => <p>Demo uses no CLI or credentials.</p>
  }
}
export default module
```

必需 UI 为 `logoSource`、`ThreadView`、`OverviewCard.project/Card`、`ThreadSettings`、
`HarnessSettings`。可选 `translations` 和 `projectBartDockMessage`（稳定消息 id）归插件。
正式 UI 应处理 actions 的错误并显示反馈；示例只演示成功路径。

复用 `@openagent/plugin-kit/renderer` 的卡片、timeline、Markdown、交互和设置控件；
使用这些组件时导入 `@openagent/plugin-kit/renderer/styles.css`，Host 提供 theme tokens。
共享组件通过 `RendererCapabilitiesProvider` 获取 Host 服务，不能访问 `window.openAgent`。
查看 [Codex Renderer](harness-codex/src/renderer/module.ts) 和
[Claude Renderer](harness-claude/src/renderer/module.ts)。

### `packages/harness-demo/src/renderer/demo.css`

```css
.provider-theme-demo {
  --provider-demo-accent: light-dark(#2459a6, #91bcff);
  color: inherit;
}
.provider-theme-demo button { color: var(--provider-demo-accent); }
```

### `packages/harness-demo/src/renderer/assets.d.ts`

```ts
declare module '*.css'
```

品牌样式留在插件内。这里同时满足现有隔离回归要求的 provider theme/accent 约定。

## 6. 注册并运行

在 `apps/desktop/package.json` 的 **dependencies** 中添加
`"@openagent/harness-demo": "workspace:*"`。声明顺序决定注册和 UI 顺序。
然后从根目录执行：

```sh
pnpm install
pnpm --dir apps/desktop generate:registry
pnpm --filter @openagent/harness-demo typecheck
pnpm typecheck
pnpm build
rg 'harness-demo|"demo"' apps/desktop/src/generated/harness-registry*.ts
pnpm dev
```

预期：依赖顺序构建完成，五个 exports 均可解析，生成 registry 的 shared/Main/Renderer
记录包含 demo，Desktop 中显示 Demo (tutorial)。Main/Renderer 使用同一 id；添加插件
不需要编辑 Core provider 列表或 switch。提交包源码、Desktop dependency、
`pnpm-lock.yaml` 和生成的 `apps/desktop/src/generated/harness-registry*.ts`；不提交 dist。
本文本身的交付只提交指南和入口，演练包保留在临时 checkout，不注册为正式产品。

## 7. 从普通 task target 扩展能力

普通 task target 只要求自身可用性和普通 Thread 行为。Bart host 另外要求 descriptor
中的 instructions、threadContext、sendContext 全为 true，并支持 `exclusive` tools；
不要为了让 demo 出现在 Bart host 选择中虚报能力。

| 接入点 | 插件责任 |
| --- | --- |
| `openThread(context.injection)` | 首次 native 请求前安装 instructions、Thread context、可选 seed、tool bindings；Handle 拥有桥接和清理。 |
| `send(request.contextEntries)` | 将每次执行上下文送入 native 请求，不把它持久化为另一套 Core 状态。 |
| `tools.mode: extend` | 保留 native tools，增加 bindings。 |
| `tools.mode: exclusive` | 只暴露 supplied bindings；这是工具集合限制，native permissions/questions 仍通过 waiting/respond。 |
| `forkThread?` | 插件派生新 Thread 的完整、未启动 state，可创建独立 native session、返回 settings/title，但不得启动执行或修改来源；Core 创建目标 Thread，初始 observation 为空。 |
| `bartContextEntries?` | 贡献 workspace、telemetry、evaluation 的最终文本，不把模型目录交给 Core。 |
| `extension?` | 插件拥有的 opaque control plane；不得变成 Host 通用后门。 |
| `dispose?` | module 资源在操作与 Thread drain 后释放，尤其是 evaluation lease。 |

Bart 使用普通 `openThread` 和同一个 Handle，并非第二种生命周期。
复用 [Plugin Kit Bart](openagent-plugin-kit/src/bart/index.ts) 与
[evaluation context](openagent-plugin-kit/src/bart/evaluation-context.ts)、
[evaluation acquisition/cache lease](openagent-plugin-kit/src/bart/evaluation-source.ts)。
Node 侧 acquisition 从 `@openagent/plugin-kit/bart/main` 导入；公共策略从 `/bart` 导入。
通过 `context.telemetryLedger` 提交 native usage 对应的事实，参考
[Claude telemetry](harness-claude/src/main/telemetry.ts) 和
[Claude evaluation](harness-claude/src/main/evaluation.ts)。evaluation 是建议，不能限制
native 合法配置；目录中的模型选择也只是当前 executable/workspace 下的 scoped choices。

## 8. 验证、手动 smoke 和排错

完成注册后执行（根目录）：

```sh
pnpm --dir apps/desktop generate:registry
pnpm --dir apps/desktop exec vitest run tests/renderer-plugin-isolation.test.ts tests/plugin-settings-isolation.test.ts tests/harness-execution-capabilities.test.ts tests/harness-thread-runtime.test.ts tests/openagent-service-harness.test.ts
pnpm codex:check
pnpm typecheck
pnpm build
pnpm dev
```

预期边界和生命周期回归通过。Bart Host 的 fixture 按 descriptor 中的实际能力计算预期；
一个 task-only 插件（`toolModes` 不含 `exclusive` 或缺少任一注入能力）不应被探测为
Bart Host，也不应通过虚报能力使测试通过。宿主策略断言已按能力角色表达（见
`docs/harness-verification-migration.md`），更换注册组合不需要重写规则正文。
直接跑 vitest 前先 generate，避免读取旧 dist；正式交付不跳过不支持 Host 的回归。

插件专属回归（协议、状态、权限、传输、telemetry、原生测试 Adapter）属于各包：
在 `packages/harness-<id>/` 下用 `pnpm --filter @openagent/harness-<id> test` 运行，
根 `pnpm test` 会经由 `pnpm -r` 包含它们。新增插件时同时提供
`src/test-support/` 原生测试 Adapter（契约见 `@openagent/test-kit`），否则依赖它的
通用 runner 会以具名错误拒绝运行。
这些既有回归不替代新 native adapter 的行为测试；应在自己的 native seam 加取消、错误、
重连、重复事件、资源释放的可观察测试。完整交付还要求 PR head 通过 CI 的 `verify`
workflow，按[仓库流程](../.agents/README.md)评审和交付。

在 Desktop 中先配置一个已有且可用的 Bart host（如 Codex），在 Bart 设置的 target
范围启用 Demo。向 Bart 发送“用 demo Harness 创建普通任务，首条输入为 hello”，由
`thread_create` 创建；其参数为 `harnessId: "demo"`、`prompt: "hello"`、
`options: {}`（不是 `settings`），可选 `cwd` 为实际存在的绝对路径。
Demo 不能作为 Bart host。无需真实模型的自动演练可使用仓库既有
[fake Codex app-server](../apps/desktop/tests/fixtures/fake-codex-app-server.mjs)，配置
`FAKE_CODEX_DYNAMIC_TOOL_NAME=thread_create` 和
`FAKE_CODEX_DYNAMIC_TOOL_ARGUMENTS='{"harnessId":"demo","prompt":"hello","options":{}}'`；
这是开发测试用 fixture，须由临时 CLI wrapper 启动并使用隔离用户数据，勿修改日常配置。

后续输入通过 Bart 定向续写发送给该 demo Thread（从俯瞰卡片发起续写，或在提问中明确 Thread），
不是把 `/wait` 当作发给 Bart host 的指令；Continue/Interrupt 按钮位于 demo ThreadView。

在 Desktop 手动逐项记录：

| 操作 | 本教程预期 | 真实 native adapter 额外证据 |
| --- | --- | --- |
| 让 Bart 以 demo 创建普通 Thread | 发现插件，创建成功；空状态无 Execution | 标准安装检测和配置路径的 availability 分别正确 |
| 发送 `hello` | 展示 You 和 Demo 回复，Execution completed，overview 摘要同步 | 真正流式输出可见，native id 只在插件内解释 |
| 发送 `/wait`，点 Continue demo | waiting-for-user → completed，显示 continued | permission/question 映射、过期响应拒绝 |
| 发送 `/hold`，点 Interrupt demo | running → interrupted | native I/O 取消，迟到事件不会重新激活 Execution |
| 关闭并重新打开已完成 Thread | 保留消息，不重放 send | 恢复 native session，测试应用重启后的恢复策略 |
| 等待中切换/重开页面再响应 | 使用同一 Host owner 正常响应 | 不出现重复监听或第二进程 owner |
| 删除测试 Thread 或退出应用 | Handle dispose；示例没有进程、timer 或订阅 | 检查子进程退出、连接关闭、listeners/tools/evaluation leases 释放 |

演练记录应列出实际执行命令、版本/commit、观察到的状态、未覆盖项和结果。
教学 adapter 的无资源 dispose 不证明真实 runtime 无泄漏；真实接入必须提供自己的证据。

| 症状 | 排查 |
| --- | --- |
| UI 中没有插件 | Desktop 是否放在 dependencies、是否 pnpm install、是否 generate；不要手工添加 Core 列表。 |
| 无法发现 package.json | 补齐 `./package.json` export；检查 workspace 包名与目录。 |
| manifest/id/完整性错误 | 默认导出 descriptor，id/包名后缀/Main/Renderer 一致；不要复用另一个插件的 id。 |
| 找不到 dist 或声明 | 检查 exports 路径和 tsconfig.build；先 generate，必要时包内 `pnpm exec tsc --build --clean tsconfig.build.json` 后重建。 |
| Renderer 打包报 Node/Electron 模块 | 检查 shared barrel、renderer 间接导入，移 native I/O 至 main/runtime。 |
| 隔离测试失败 | 不导入其他 Harness 或 Core 实现；共享能力提炼到合适的 Plugin Kit 边界。 |
| Thread 一直 running 或等待无法响应 | 检查 commit 是否 await、interaction id/action 是否与 native 映射一致，以及同一 Handle 是否被长任务堵住。 |
| 安装成功但不能运行 | presence 不等于 availability；检查配置路径、认证、cwd 和取消信号，勿靠 settings UI 推断。 |
| 设置/模型被 Bart 错误拒绝 | 检查是否复用统一 resolver；evaluation 不得覆盖 native 合法性。 |
| 卡片无结构样式/资源丢失 | 导入 kit styles，包 build 复制插件资产，exports 指向实际输出。 |

最终边界清单：shared 无进程依赖；Main 拥有 native I/O；Renderer 只拥有视图；
Harness 之间互不依赖；Core 只经生成 registry 组合；Host commit 将插件 state 与纯投影
observation 原子发布；一个 Thread 一个 Handle owner；Report HTML 不获得任何 Host 能力。

独立模型服务通过 [Provider Plugin](PROVIDER_PLUGIN_GUIDE.md) 绑定。Harness 只应用其声明支持的注入格式；自带订阅继续由原生 Harness 管理。
