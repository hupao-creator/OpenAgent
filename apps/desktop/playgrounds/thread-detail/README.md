# Thread detail playground

Thread 详情的统一 Notion UI 与真实 Harness renderer 预览，评审锚点为 [PR #15](https://github.com/xinyuan0801/OpenAgent/pull/15)。Codex、Claude Code 已接入共享展示组件；Report 保留独立 HTML runtime。

## 启动

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm playground:thread
```

打开 <http://127.0.0.1:4176>。服务仅监听回环地址，端口占用时直接报错。预览通过插件公开入口加载组件，并复用 `watch-desktop.mjs --playground` 监听所有 workspace 包的源码及资源：依赖顺序构建、刷新注册表后，Vite 接收产物更新，无需维护具体插件源码别名、启动 Electron 或配置 Agent。Playground 使用独立的 Vite 依赖缓存，避免桌面构建或测试清理缓存后使 Markdown worker 无法加载。

```sh
pnpm playground:thread:check
pnpm playground:thread:build
```

启动、独立检查和构建命令会先通过 `generate:registry` 按依赖顺序构建 workspace 包并刷新注册表，全新检出无需手动准备 `dist`。构建输出为 `apps/desktop/out/thread-detail-playground/`。常规 `pnpm typecheck` 同时检查 playground，复用应用检查已完成的依赖构建；没有新增依赖或测试用例。

## 两个视图

- **插件接入**（默认）：使用正式 `AgentThreadWorkspace` / `BartThreadView`，经生成注册表加载各 Harness renderer。`src/native-fixtures/` 提供符合各自 schema 的本地 Plugin state 与 Public observation。授权、问答的 ID 映射和 payload 由真实插件代码处理，预览仅模拟响应后的运行状态。
- **设计稿**：保留最初评审的统一原型，包含完整的演示续写、附件预览、布局标注等交互。数据不作为运行时契约。

所有输入、审批和执行只作用于本地样例；回复、输出和文件变更为固定内容，不连接真实 Agent。插件接入视图可查看“最近提交”来核对响应。原生 CLI 设置、MCP、分支、文件选择等能力应在桌面应用中使用；预览会明确提示。

## 设计与行为

参考用户指定的 [Notion DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/notion/DESIGN.md)：白色画布、暖灰文字、细分隔线、文档标题、8px 控件和紫色主操作，使用已有 Inter 字体。明暗主题使用同一套布局。

正式插件界面在文档标题上方展示一次页面 emoji，支持插件传入图标。普通 Thread 移除整条 Header 及其元信息，仅在详情左上角悬浮返回按钮，滚动时保持可用，不为导航占用单独的布局行。桌面端保留透明拖动区域，macOS 返回按钮避开窗口控制键；正文初始留白通过共享样式的 `--thread-detail-top-space` 预留。显示工具栏只保留用户消息与执行过程的开关。每轮消息不设置 Agent 头像或作者栏，页面底部不设页脚。

用户消息默认隐藏，可通过“显示用户消息”查看，附件随所属消息切换。执行过程默认收起，仅当前真正执行中的轮次自动显示；完成、停止、失败和等待操作时自动收起。手动开启“显示执行过程”会展示所有轮次，包括执行期间的历史轮次及 Claude 分支历史；同一次执行的流式更新保留手动选择。执行状态由各插件结合 Public observation 与 Native turn 判定，历史轮次不会随新的执行自动展开。

运行状态由各插件根据 Public observation 的 `latestExecution.status` 传入，正式接入三个 Harness 的 Thread 与 Bart 页面；启动阶段尚无消息时也算运行中。只有 `running` 计入，等待授权/回答、完成、失败和停止时移除，单独的后台任务不会触发。页面不再绘制运行描边，只保留一个视觉隐藏的 `role="status"` 元素朗读“运行中”，供辅助技术感知状态变化。当前运行轮次不再显示末尾状态，历史轮次仍保留状态与时间。

三个插件的空 Thread 统一显示小猫与电脑的 ASCII 图，不再显示 Harness 专属的空态文案或无内容可切换的显隐按钮。阅读区宽度达到1024px时，正文顶部留白收紧至24px；窄屏继续避让悬浮返回按钮。

三个插件均不渲染 Changes/工作区 diff 区块，包括历史与 Claude 分支历史。回复和 review 独立于执行过程显示，review 使用无外框的折叠行；流式文本不追加尾部光标。行内代码与正文共用基线，长内容随段落折行，不使用独立滚动盒。授权、问答与独立的轮次或系统错误保持可见；工具消息（含失败工具）统一收进执行过程，展开后保留失败状态和详情。请求使用细分隔线、灰色代码块、属性行及简洁选项，不使用外框和整块警示底色。各插件保留自身的许可范围、问题类型和扩展操作。

问答的“其它…”原位替换成输入框并自动聚焦，不增加额外一行；空值失焦或 Escape 可退出。单选与自定义答案互斥，多选允许附加自定义答案，无选项题保留常驻输入框。

## 场景与控件

九个场景覆盖完成、流式执行、等待授权、等待回答、失败、停止、后台任务、空 Thread 和160轮长历史。历史初始加载120轮，可加载更早40轮并保持阅读位置。

侧栏支持 Harness、Thread/Bart、自适应/960/640px 画布与舒适/紧凑间距；设计稿还支持布局标注。顶栏提供浅色/深色、场景链接、重置与专注预览。链接保存视图、入口、场景和展示选项，不保存输入或执行进度。

插件接入直接复用正式组件及插件状态，没有额外的预览包裹层；页面与预览外轮廓都不再绘制运行描边，侧栏也不提供描边样式或动画控件（`indicator`、`motion` 参数已随之移除）。

## 组件与插件边界

共享实现位于 `packages/openagent-plugin-kit/src/renderer/harness-card/thread-detail.tsx` 与 `thread-detail.css`。

| 组件 | 职责 |
| --- | --- |
| `ThreadDetailFrame` | 宿主页面边界；嵌套时由最外层绘制 |
| `ThreadDetailSurface` | 消费插件给出的运行状态、页面 emoji/扩展操作插槽、文档标题、744px阅读列、显示开关、消息窗口与滚动跟随 |
| `ThreadDetailTurn` | 按插件给出的 user/work/content/attention 分类展示节点与轮次状态，不添加作者栏 |
| `ThreadDetailRequest` | 为插件自己的 header/body/footer 提供统一请求区块 |
| `ThreadDetailEmptyState` | 共享 ASCII 空态及本地化的无障碍描述 |
| 既有 Timeline/Activity/Plan/Question 组件 | Markdown、附件、工具明细、计划、选项与本地回答状态 |
| `InteractionOtherAnswer` | 将“其它…”选项原位切换为自定义回答输入框 |

每个 Harness 自己解析 Native state、排列和分类消息、判断运行状态、映射交互身份、验证过期请求并调用真实响应接口。共享组件只消费展示属性及 React 节点，不依赖任何 Harness 包或 Native schema。Core 继续通过生成注册表组合插件，只负责页面边界、导航、Bart 输入和应用能力注入，不判断 Harness 运行状态。

Claude runtime/MCP/remote/background/fork、Codex 后台终端与系统错误等仍由对应插件渲染。没有变更运行时契约、生成注册表或 Report HTML runtime。旧 T3Code 时间线与工具 dock 已移除。

## 验证与交付

原有测试用例已适配默认隐藏与共享 DOM；构建、类型检查、测试和浏览器验证记录见 PR。实现已接入正式插件，PR 尚未合并。

## Document reading (#63)

`?renderer=plugin&scenario=local-five&harness=codex&kind=agent` previews the saved five-turn Codex conversation. Both remaining Harness renderers can display this same recorded content; it is not a native Claude conversation and has no imported usage. Other scenarios use explicit fixed protocol fixtures with known token categories. Both Agent and Bart render production navigation with the preview parent label “Thread 详情”. Subpage transitions use production CSS.
