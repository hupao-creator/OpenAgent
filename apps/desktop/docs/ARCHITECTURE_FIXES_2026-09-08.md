# OpenAgent 架构问题修复记录

日期：2026-09-08。对应 [原审查报告](./ARCHITECTURE_REVIEW_2026-09-08.md) 的 F01–F15。

修复围绕资源所有权、状态权威和显式模块接口展开；不以文件拆分或行数下降作为完成标准。

| 编号 | 已实施的边界与行为 | 主要回归证据 |
| --- | --- | --- |
| F01 | `AttachmentRepository` 持久化 Thread→附件所有权；发送前登记，fork 继承，删除/清空后释放。GC 使用全部所有者；索引丢失或损坏时停止回收。 | 附件所有权持久化、共享引用、fork、Bart reset 后 Agent 引用保留、索引损坏/缺失。 |
| F02 | Codex 原生 delta/final、批处理、timeline 全程保留必填 `itemId`，按实体更新；`answer` 从消息时间线派生。 | A/B 交错消息、乱序 final、重复事件、批处理、终态结算；缺失/非法 ID 拒绝。 |
| F03 | Claude `activities/interactions` 是当前状态权威，timeline 保留顺序与 checkpoint 历史；统一记录函数覆盖终态、用户回应、后台通知和恢复。 | 完成、失败、中断、重启恢复、当前实体与旧快照冲突、历史容量边界。 |
| F04 | Renderer 接受权威状态不再受视觉回调异常阻断；布局捕获失败单独诊断，保留逐次 transition。 | 视觉失败注入、正常 revision 前进、诊断失败隔离、A→B→A 连续布局变更。 |
| F05 | contracts 统一 public observation 结构校验与字段上限，Runtime/Store 复用。Codex 全部交互展示字段遵守公共上限，原生身份、选项答案和完整 schema 留在私有模型；结构或体积不符合准入约束的原生交互在进入 pending 状态前拒绝。 | Runtime/Store 接受集合、NUL/长度/字段边界、超大 schema 投影、长选项答案往返、无效原生交互拒绝、完整 JSON 字节预算。 |
| F06 | `ThreadStateStore` 管理内存与命令 scope；`PartitionedStatePersistence` 按 Thread、Report metadata/HTML、settings、UI 分区，原子 manifest 发布。执行 admission 使用 `flushThread`。 | 分区容量、单实体写入、报告阻塞时其他线程提交/flush、版本竞争、同值回退栅栏、失败恢复、孤儿清理、关停 barrier。 |
| F07 | 配置查询按 settings/workspace 指纹判断失效；settings 与 metadata 使用字段级 mutation。内容是否存在由 owning Harness 的 `hasThreadContent` 提供，设置更新在解析后及线程 scope 内再次检查该事实。 | 非空私有 envelope 但无原生内容、解析/排队期间出现内容、无关 streaming 不使查询失效、元数据保留最新内容。 |
| F08 | Main plugin 显式提供轻量 `availability.probe`，Bart 可单独提供能力检查；执行检查不再加载 settings presentation/model catalog。 | 可用性与 presentation 解耦、CLI 失败/取消、三家 Harness 组合。 |
| F09 | contracts 保留 DTO、能力接口和边界校验；Bart 准入政策、评测格式化、遥测编排移入 `plugin-kit/bart`，Node hashing 位于 `/bart/main`。 | 原 Bart policy/telemetry/evaluation suites、包构建与依赖边界检查。 |
| F10 | Desktop 启动层解析运行环境，通过 `HarnessPluginHostContext.providerOverride` 显式注入三家 Harness；移除 kit 全局 `.env` 加载与缓存。 | 环境隔离、真实测试子进程收到 Claude 配置、无 override 路径。 |
| F11 | `RendererCapabilitiesProvider` 注入外链与诊断能力；共享 Markdown/diagnostics 不再依赖 `window.openAgent`；playground 使用自己的显式能力。 | 无 Desktop bridge 的链接与诊断、独立 provider、Renderer/playground 类型检查和浏览器运行。 |
| F12 | Codex 私有 MCP 模型使用明确 form/url 可判别联合，保存 schema、URL、question ID；Renderer/响应编码器按模型分支处理。 | MCP form/url 编解码、公共交互投影、交互 UI。 |
| F13 | 卡片自身注册 `status`/`excerpt-end` 实测锚点与可见性操作；运动模块消费注册表，移除私有 DOM 搜索与 CSS 偏移假设。 | 锚点实测/冻结快照、坐标转换、缺失/卸载、600 帧等待超时后同 ID 卡片恢复可见。 |
| F14 | App 订阅导航/全局设置，独立 surfaces 和按 ID hooks 订阅内容；目录/标签/筛选有自己的失效条件。 | Bart-only streaming 不触发 Agent Overview；后台更新零 Overview 投影；六组真实浏览器基准。 |
| F15 | GUI/Bart 的现有 read/respond/interrupt 路径共享 `ThreadLifecycleService` 和响应校验；Bart delete 使用独立用例并由 Service 提供复用入口。17 个 tool schemas 移入 `bart-v1/core-tool-adapter.ts`。 | 现有入口共享行为、取消/后台任务/worktree/删除竞态、Bart tool schema 与 Service 全套回归；未新增 GUI 删除入口。 |

## 持久化约定

当前状态只读取 `openagent-state-v5/manifest.json`，不自动迁移或覆盖旧命名空间；这是仓库“未发布、仅支持当前 schema”的既有约定。启动旧工作区时不会自动呈现旧 v4 Thread/Report 状态。独立的 worktree/schedule/evaluation 仓库仍使用原有命名空间。

50 MiB 从全应用内容上限改为每实体文件上限，manifest 单独限制为 8 MiB。每个仓库只有一个写入 owner。完整的命令 scope、发布顺序、失败恢复和 flush 语义见 [状态持久化边界](./STATE_PERSISTENCE.md)。

## 验证

以下全量数字记录初次架构修复的验证。PR review 后的最终提交验证，以 PR 中绑定受检 SHA 的完整验证结果为准。

- `pnpm test` 通过：95 个 Desktop 测试文件、1,051 项测试，以及 2 项根目录开发脚本测试全部成功。
- `pnpm build` 通过：workspace packages、生成注册表、Main/Web TypeScript 和 Electron Main/preload/Renderer 生产构建均成功；线程 playground TypeScript 检查也通过。
- 真实 Electron Report runtime 隔离测试通过。
- `test:lifecycle-runtime` 在最终构建上顺序运行，9 个场景全部通过：三次全新启动、目录初始化、评测加载、遥测加载、状态加载、headless listen、第二次终止信号；验证了完整测试进程树退出。状态加载 gate 同步更新为 v5 manifest 路径。
- `git diff --check` 通过。
- 对 288 个生产 TS/TSX 文件做 import/export 文本提取与 workspace exports 解析，共 1,092 条项目内引用；包含 type-only 的引用图无环，Core→具体 Harness、插件互引、packages→Desktop、shared/renderer 进程边界检查均无违规。此扫描不覆盖计算得到的动态依赖，不替代 TypeScript 和行为测试。
- 真实浏览器运行三家 Harness × overview/background 六个场景，每组 48 线程 × 24 轮、60 samples，均到达 revision 71，无浏览器错误/警告；后台场景的 Overview 投影次数均为 0。数据及测量限制见 [性能验证](../benchmarks/ARCHITECTURE-FIX-PERFORMANCE.md) 和 [原始结果](../benchmarks/architecture-fix-results.json)。

测试使用隔离临时状态、协议 fixtures 和测试子进程，未启动真实模型任务。浏览器时延是单次本机测量，不据此宣称所有场景性能提升。

## PR #44 review 修复

针对受审提交 `04776aa88475c27b03cdc75254cc089a34f8a3af` 的三项发现，追加以下行为修复：

| Review | 修复与回归 |
| --- | --- |
| [私有内容所有权](https://github.com/xinyuan0801/OpenAgent/pull/44#discussion_r3953614669) | 移除 Core 的 `sessionState !== null` 内容推断。三个 Harness 解释各自原生 session/turn 状态，Core 只使用显式内容事实；在线程 scope 已取得后重查内容，防止排队期间失效的设置结果落盘。 |
| [终态消息身份](https://github.com/xinyuan0801/OpenAgent/pull/44#discussion_r3953614680) | Runtime 与私有状态复用 ID 校验；不再生成 `turn-final-*` 占位身份。终态列表整批验证后才发布 final；非法 delta/item-completed 也通过受控失败结束，覆盖 ACK 前协议异常及随后新执行恢复。 |
| [生产发送路径的持久化](https://github.com/xinyuan0801/OpenAgent/pull/44#discussion_r3953614687) | Bart/Agent 发送回调使用各自线程的 `flushThread`；shutdown 仍用全局 flush。新增真实 Service 入口回归，证明 Agent 新执行、active follow-up、Bart 用户/系统消息、Bart 工具转发在报告 HTML 被阻塞时均能完成接收及自身持久化。 |
| 独立架构复核追加：附件索引故障阻断启动 | 索引 reconciliation 与 GC 处于同一个受控维护边界。索引缺失或损坏时报告错误、跳过 GC、保留文件及无效索引，应用和纯文本发送仍可用；依赖附件所有权的操作继续拒绝执行，不推断或迁移未知所有权。两个 Service 启动回归在修复前失败、修复后通过。 |
| [公共交互字段边界](https://github.com/xinyuan0801/OpenAgent/pull/44#discussion_r3953712526)（复审追加） | 全部展示文本按 contracts 的公共上限投影，必填文本保持可显示；原生身份和选项原值不因展示裁剪而改变。原生交互在 pending 登记和事件发布前验证私有结构与公共投影，拒绝不符合结构契约或产生身份歧义的输入。回归覆盖字段边界、协议拒绝，以及长且展示前缀相同的选项返回完整原生答案。 |
| [交互总量预算](https://github.com/xinyuan0801/OpenAgent/pull/44#discussion_r3953818687)（复审追加） | Codex 对单次交互的完整私有 JSON 和公共投影各设 8 MiB 的 UTF-8 字节准入上限，包含 MCP schema、键名、JSON 转义、字段聚合及公共身份扩张。超限时在 pending 登记前返回协议错误，同一执行后续合法请求仍可处理。 |

回归先在原实现上失败，再验证修复：内容所有权的两个初始复现失败、终态 ID 的八类初始复现失败、报告阻塞下的五条发送路径失败。具体测试位于 Service、Codex transport、ThreadStateStore 及 Harness content-presence suites；不以仅直接调用 `flushThread` 的单元测试替代生产发送入口证据。

单次交互预算属于 Codex 原生准入策略，私有结构检查先于公共投影，避免先展开超大 schema。它独立于 Desktop 的每 Thread 记录容量；累计历史仍由持久化层执行总容量检查。恢复 decoder 保留既有私有结构规则，准入限制不改变原生答案或推断剩余历史容量。
