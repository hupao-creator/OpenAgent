# OpenAgent 模块边界与耦合审查

日期：2026-09-08

基线：[f3230c5a36446b8a1985f99b6b5b29a0be8cb6da](https://github.com/xinyuan0801/OpenAgent/commit/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da)

范围：Desktop main / shared / preload / renderer、contracts、plugin-kit、三个 Harness，以及相关测试、构建配置和架构说明。审查阶段未修改业务代码。

本报告记录上述基线的历史问题，源码链接固定到该提交及审查时的行号。后续修复及验证见 [修复记录](./ARCHITECTURE_FIXES_2026-09-08.md)。

## 审查结论

当前项目的包级依赖方向比较清楚，主要缺陷集中在**状态、资源、协议和控制流程的所有权**。有些功能已拆成独立文件或包，但仍通过全局状态、完整 Thread 对象、字符串约定、私有 DOM 和共用持久化队列紧密连接。

最应先处理的是：附件回收遗漏 Agent 引用；Codex 消息身份在事件边界丢失；Claude 当前状态与时间线快照相互矛盾；视觉编排可以阻止状态提交；Public observation 在不同边界使用不同合法性规则。这些问题已经超出命名或目录组织层面。

本报告保留 15 项发现。P1 表示有资源损失风险，应优先修复；P2 表示明确的行为缺陷或实质边界耦合；P3 表示尚未证明当前用户故障的维护、扩展问题。编号不表示这些问题必须分别拆成 15 次重构。

## 方法与证据范围

- 对 274 个生产 TS/TSX 文件做静态 import / export 扫描，约 80,358 行；包含生成注册表，不含测试、声明文件、CSS、实验室和 playground。
- 解析相对路径及 workspace package exports，得到 1,023 条项目内引用记录；区分 type-only 与运行时引用，并计算强连通分量。
- 对主进程、Renderer、公共包和三个插件并行追踪职责与调用链，结合相关测试核对设计意图。
- 四项做了最小执行验证：附件 GC、Codex 消息投影、Claude 终态投影、Renderer 视觉回调失败。采用当前源码和 Node 内置 TypeScript 转换；不是完整 Electron / CLI 端到端测试。
- 静态图扫描使用文本提取和路径解析，不是完整 TypeScript 编译器分析；不覆盖计算得到的动态依赖。未解析的源码资源引用为 SVG 等非 TS 资源。
- 审查阶段工作树没有安装 node_modules；审查时未安装依赖、未运行全量 typecheck / Vitest / build，也未调用真实模型。历史性能数据只作现有证据，不当作本次测量。后续修复阶段的验证另见修复记录。

| 静态检查 | 结果 |
| --- | ---: |
| 运行时文件引用环 | 0 |
| 包含 type-only 引用的文件环 | 0 |
| Core 绕过 generated 直接引用具体 Harness | 0 |
| Harness 直接引用另一个 Harness | 0 |
| packages 直接 import Desktop 源码 | 0 |
| shared → main / renderer，renderer → main / bart 的已解析引用违规 | 0 |

无循环 import 不等于低耦合。回调、共享数据、DOM 和进程环境形成的依赖不会出现在普通 import 环检测中。

当前主要包关系：

~~~mermaid
flowchart LR
  Desktop["Desktop"] --> Registry["Generated registry"]
  Registry --> Harness["Codex / Claude / OpenCode"]
  Desktop --> Contracts["contracts"]
  Desktop --> Kit["plugin-kit"]
  Harness --> Contracts
  Harness --> Kit
  Kit --> Contracts
~~~

## 发现总表

| 编号 | 优先级 | 不合理边界 | 直接影响 | 证据 |
| --- | --- | --- | --- | --- |
| F01 | P1 | 附件使用范围大于 GC 所有权范围 | Agent 引用的暂存副本被误回收 | 最小复现 |
| F02 | P2 | Codex 事件丢失消息实体 ID | 多消息时间线重复、覆盖错误 | 完整终态的 reducer 复现 |
| F03 | P2 | Claude 当前状态与 timeline 双重权威 | 已取消活动仍呈现 running / pending | 最小复现 |
| F04 | P2 | 状态提交依赖视觉回调 | 布局异常阻断 Renderer 接受更新 | 失败注入复现 |
| F05 | P2 | Runtime / Store 各自定义 observation 校验 | Runtime 接受的数据无法提交 | 源码触发链 |
| F06 | P2 | 全应用共用持久化聚合与容量 | Report 与 Agent 互相占用容量、阻塞提交 | 源码确定 |
| F07 | P2 | Thread 单一 revision 代表多类事实 | 无关流式更新使设置查询失效 | 源码确定 |
| F08 | P2 | 执行可用性依赖 settings presentation | UI catalog 查询成本进入执行控制路径 | 源码确定 |
| F09 | P2 | contracts 混入产品策略与副作用编排 | 稳定契约包成为业务变化中心 | 源码确定 |
| F10 | P2 | plugin-kit 隐式读取全局运行配置 | Host 注入失去环境隔离能力 | 源码确定 |
| F11 | P2 | 共享 Renderer 依赖桌面全局桥 | 独立复用必须伪造 window.openAgent | 源码确定 |
| F12 | P2 | Codex 交互语义藏在字符串约定中 | Runtime / Renderer 必须同步猜测协议 | 源码确定 |
| F13 | P2 | 运动模块依赖卡片私有 DOM / CSS | 布局修改跨包扩散且不受类型保护 | 源码确定 |
| F14 | P3 | App 全量订阅绕过按线程边界 | 单线程变化触发全局列表派生 | 结构证据；未证明卡顿 |
| F15 | P3 | Bart adapter 同时拥有 Thread 用例 | 相同业务规则在入口间重复维护 | 结构证据 |

## 具体发现

### F01 · P1 · BartAttachmentStore 已服务全部线程，GC 却只承认 Bart 引用

**位置：** [普通 Thread follow-up](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L687)、[启动 GC 活引用收集](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L456)、[删除过期附件目录](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/services/bart-attachment-store.ts#L159)、[Codex 普通文件输入转换](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/runtime/input.ts#L39)。

同一个附件仓库被 GUI、headless、Bart 和普通 Agent follow-up 使用，但启动时只从当前 Bart transcript 收集活引用。目录超过 24 小时且不在此集合，就被作为孤儿删除。Codex 普通文件输入保留暂存副本的绝对路径，没有在该转换处另存一份内容。

**触发场景：** 文件只发给 Agent，或 Bart 会话被清空但 Agent 仍引用该文件，超过 TTL 后重启。原生历史还保存路径，路径对应的文件已经消失。

**最小验证：** 执行真实 BartAttachmentStore 和 toCodexWireInput，创建同龄的 Agent / Bart 附件，按启动逻辑提供活引用。Codex mention 指向的 Agent 附件在 GC 前存在、GC 后不存在；Bart 附件保留。

**影响边界：** 删除的是应用管理的暂存副本，不是用户原始磁盘文件。Claude 标准图片 / PDF 已嵌入 base64，不能推广为所有附件内容都丢失。

**建议：** 将资源所有权提升到 Core AttachmentRepository，发送时登记 Thread 与附件的引用或租约，删除线程或历史时释放；GC 依据完整引用集合。仅重命名 BartAttachmentStore 无法解决问题。

### F02 · P2 · Codex Runtime 丢弃 itemId，状态层被迫按位置猜测消息

**位置：** [delta 丢弃 itemId](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/runtime/app-server.ts#L1235)、[final 事件同样无 ID](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/runtime/app-server.ts#L1484)、[仅覆盖最后一个 assistant](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/shared/state.ts#L991)、[Renderer 使用 timeline](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/renderer/ThreadView.tsx#L333)。

Runtime 原本知道每条消息的原生 ID，但私有 text-delta / text-final 事件没有保留身份。共享状态按末尾节点追加、按最后一个 assistant 完成；answer 和 timeline 又分别维护内容。

**已复现输入：** delta A → activity → delta B → final A → final B → completed。分别执行 done reducer 和实际 Controller 使用的 settleCodexExecution，最终均得到：

    status: completed
    answer: A\n\nB
    timeline: user → A(complete) → activity → A(complete) → B(complete)

第一条 A 重复，原 B 节点被覆盖成 A，B 被追加到末尾。终态只完成状态，不修复内容。streaming 只存在于结算前，不作为最终故障描述。

**建议：** 在插件私有事件中保留 itemId，按消息实体 ID 更新；answer、timeline 和 Renderer 从同一消息集合派生。这里不需要把 Codex 原生协议泄漏到 Core。

### F03 · P2 · Claude activities / interactions 与 timeline 快照没有共同的终态权威

**位置：** [活动快照](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-claude/src/main/thread/timeline.ts#L85)、[交互快照](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-claude/src/main/thread/timeline.ts#L98)、[终态结算](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-claude/src/main/thread/timeline.ts#L191)、[Renderer 选择 timeline 最新快照](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-claude/src/renderer/thread/TurnView.tsx#L203)、[重启恢复调用](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-claude/src/main/thread/controller.ts#L110)。

timeline 克隆活动、交互对象。settleClaudeTurn 更新 turn.activities / interactions，却没有同步这些 timeline 快照；Renderer 又直接使用 timeline 的最新快照作为展示状态。

**最小复现：**

    executionOutcome: interrupted
    canonicalActivity: cancelled
    rendererActivity: running
    canonicalInteraction: cancelled
    rendererInteraction: pending

**建议：** 明确 timeline 的语义。若它是当前展示顺序，只保存实体引用；若它是事件历史，由统一 reducer 追加终态事件，再从历史投影当前状态。不能让“历史快照”和“当前实体”同时充当当前状态。

### F04 · P2 · Renderer 状态提交受 Overview 视觉编排控制

**位置：** [先回调后 setState](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/renderer-store.ts#L55)、[App 的 beforeStateCommit](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/App.tsx#L336)、[异常只处理 revision gap](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/renderer-state-sync.ts#L27)。

beforeCommit 包含删除占位、前后集合投影、布局比较和动画目标生成。任何同步异常都会发生在 store.setState 之前；同步层对非 gap 错误直接抛出，本次 Main 已提交的更新没有进入 Renderer。后续更新才可能因 gap 触发恢复。

**最小验证：** 使用当前提交函数和 normalization，替换 patch 构造为测试桩，在视觉回调注入异常：Main revision=2，Renderer 仍为 1，setState 调用次数为 0。该验证证明失败传播关系，不表示正常布局必然抛错。

**建议：** 状态模块产生不可变 transition，视觉编排消费 transition，并独立隔离失败。保留现有逐次 A→B→A 变化顺序；若必须同步捕获布局，也必须保证捕获失败不会阻止权威状态落入 store。

### F05 · P2 · Public observation 的合法性有两个定义

**位置：** [Runtime question 校验](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/harness-thread-runtime.ts#L1864)、[Store 字段校验](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/openagent-state.ts#L435)、[Store 拒绝 observation](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/openagent-state.ts#L532)、[Codex schema 加说明前缀](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/runtime/app-server.ts#L2085)、[Public interaction 原样映射](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/shared/public-interactions.ts#L56)。

Runtime 只要求 question.prompt 为非空字符串；持久化要求最长 20,000 字符且不能含 NUL。Codex 先把 schema compact 到最多 20,000 字符，再拼接说明前缀，存在超过 Store 限制的明确生产路径。

**后果：** 大 schema 的 MCP elicitation 可通过 Runtime 校验，却无法提交 waiting-for-user observation。插件必须遵守没有暴露在公共边界中的 Desktop 私有规则。

**建议：** contracts 统一定义 public observation 的结构校验、字段限制和必要规范化。Runtime 只额外校验生命周期迁移；Store 复用同一结构校验器。与 F09 不矛盾：边界校验属于契约，模型路由政策不属于契约。

**证据限制：** 已追踪具体源码链，未驱动真实 CLI 发起大 schema 请求。

### F06 · P2 · ThreadStateStore 实际承担整个应用的持久化事务

**位置：** [整个应用的 50 MiB 上限](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/services/thread-state-store.ts#L21)、[全局提交队列](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/services/thread-state-store.ts#L199)、[非合并写等待持久化](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/services/thread-state-store.ts#L224)、[完整 JSON 序列化](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/services/thread-state-store.ts#L394)、[报告更新替换 reports 集合](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/use-cases/report-service.ts#L104)、[执行 admission flush](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/harness-thread-runtime.ts#L1474)。

ThreadStateStore 包含所有线程的 sessionState / observation、Report HTML、设置和 UI 选择。无关业务共用容量预算、序列化和提交队列。更新一个报告会重写全应用快照；执行 admission 还会等待全局 flush。

**后果：** 报告历史增长增加无关执行的 I/O 成本；共享容量接近上限时，一个 Agent 的 observation 增长也可能被拒绝。已有 debounce / coalescing 减少了写入频率，但未改变事务和容量边界。

**建议：** 先分离 Report HTML 大内容，再按线程划分持久化单元，设置 / UI 单独存储。只在确有业务不变量时做跨实体事务，保留必要的 revision 与 Renderer 发布顺序。无需立即引入复杂事件总线。

**证据限制：** 未做本次性能或容量压测，不量化延迟。

### F07 · P2 · 一个 Thread revision 同时表示配置身份和流式内容

**位置：** [sessionState 更新增版本](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/openagent-state.ts#L516)、[observation 更新增版本](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/openagent-state.ts#L538)、[设置查询要求总 revision 不变](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L3995)、[设置更新重试](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L819)、[metadata 替换完整 Thread](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/use-cases/thread-metadata-service.ts#L224)。

配置、cwd / worktree、title / tags、流式状态共享同一 revision。设置 presentation 查询已经比较配置和工作区，还额外比较总 revision。因此一个完全无关的 observation 或标题更新，也可以使查询失效；设置更新则最多重做发现 16 次。

**建议：** 配置与工作区使用独立版本或明确指纹；元数据使用字段级 mutation，避免持有并替换完整 Thread。总 revision 可以继续用于传输排序，不必再承担所有业务的并发前置条件。

**证据限制：** 已确认 guard 和更新路径，未运行竞态时序测试；不据此宣称每次运行中设置查询都会失败。

### F08 · P2 · availability 经由 settings presentation 获取

**位置：** [composition 中的调用方向](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/harness-composition.ts#L370)、[Codex presentation 加载](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/index.ts#L145)、[最终只取 cli.available](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/module.ts#L55)、[执行前调用](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L2447)。

availability / bartHostAvailability 先加载完整 settings presentation。Codex 会构造 AppServer 并等待版本、模型列表，而可用性最终只消费 CLI 是否可用。用于下拉选项的查询因此进入 Bart host 选择、target 刷新和执行前检查。

**建议：** 独立的 availability / capability probe 返回执行所需事实；presentation 复用这些事实，再按需加载 catalog。可复用连接和缓存，但业务控制不应依赖展示 DTO 的加载成功与成本。

### F09 · P2 · contracts 的“契约”边界混入 Bart 产品政策

**位置：** [评测准入算法](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-contracts/src/bart-evaluation-facts.ts#L224)、[路由提示词与评测格式化](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-contracts/src/bart-evaluation-facts.ts#L250)、[遥测写入编排](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-contracts/src/bart-telemetry.ts#L365)、[插件直接消费](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-opencode/src/bart/index.ts#L4)。

公共包同时拥有 DTO、固定评测源 / benchmark 定义、模型身份匹配、准入政策、产品英文提示词，以及调用 ledger.record 的编排。contracts 与 plugin-kit 的职责划分因此不稳定。

**后果：** 改路由策略或提示词需要改全部插件依赖的基础契约包。三插件当前共享实现虽避免了复制，但共享位置把业务变化传播到最底层。

**建议：** contracts 保留 DTO、能力接口和边界校验；Bart policy / domain 模块承载准入、匹配、格式化与遥测聚合，由 Core composition 组织。无需改变现行准入政策本身。

### F10 · P2 · plugin-kit/main 通过全局环境变量决定全应用运行政策

**位置：** [硬编码 DeepSeek](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/main/bart-headless-environment.ts#L17)、[进程级缓存](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/main/bart-headless-environment.ts#L26)、[自行读取 cwd / .env](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/main/bart-headless-environment.ts#L73)、[既有 Host environment 能力](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-contracts/src/harness-module.ts#L24)。

该共享模块直接读取进程环境和 .env，绕过 Host context，并缓存一次解析结果。它的使用不限于 Bart： [Codex standard runtime](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/runtime/index.ts#L89)、[Claude transport](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-claude/src/main/runtime/transport.ts#L289)、[OpenCode model catalog](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-opencode/src/main/runtime/model-catalog-client.ts#L51) 都受影响。

**触发范围：** 开启 OPENAGENT_BART_HEADLESS_PROVIDER 后成立；没有开启时不会自动切换提供商。此处质疑的是配置所有权和隐藏依赖，不是 headless 测试应否使用该提供商。

**建议：** 由 Desktop / headless composition 解析一次环境并显式注入运行配置；kit 只提供纯解析函数，各 Harness 转换自己的原生配置。

### F11 · P2 · 共享 Markdown 组件隐式依赖 Desktop preload

**位置：** [MarkdownBody 自建桥接类型](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/renderer/components/MarkdownBody.tsx#L11)、[直接调用 window.openAgent](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/renderer/components/MarkdownBody.tsx#L42)、[诊断的类似依赖](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/renderer/diagnostic-tracing.ts#L112)、[playground 安装假全局桥](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/playgrounds/thread-detail/src/main.tsx#L11)。

组件没有 openExternal 参数，却先阻止链接默认行为，再调用 Desktop 全局桥。独立浏览器宿主需要知道未在组件 API 中声明的约定；桌面 API 改名也不受这份自建类型约束。

**建议：** 用小型 Renderer capabilities context 或 onOpenLink / diagnostic sink 注入能力。已有 [HarnessRendererThreadActions.openExternal](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-contracts/src/renderer/harness-plugin.ts#L39) 可作为明确能力链的一部分。Desktop 与 playground 分别提供实现。

### F12 · P2 · Codex MCP form / url 被压成泛型交互，再由 Renderer 反推

**位置：** [私有 interaction 类型](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/shared/types.ts#L163)、[Runtime 编码 MCP](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/main/runtime/app-server.ts#L2066)、[Renderer 根据动作和 values 判断类型](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/renderer/ThreadView.tsx#L633)、[再次识别 values](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/harness-codex/src/renderer/ThreadView.tsx#L654)。

MCP form / url 没有明确判别字段，而被装入 user-input / permissions；schema、URL、说明共用 detail，表单通过特殊 question ID values 表达。Renderer 依赖 submit + deny 和 values 推断协议类型。

**后果：** parser、响应编码器、持久化模型和 Renderer 共享未明示的字符串约定。只改其中一层时，编译器无法发现语义不一致。

**建议：** 插件私有模型使用明确的可判别联合，保存 schema / url；由统一映射输出 Core 公共交互。不要为了“通用”先丢掉自身插件需要的语义。

### F13 · P2 · Bart 运动模块跨边界依赖卡片私有几何与 DOM

**位置：** [硬编码 logo 几何偏移](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/bart-motion/session.ts#L34)、[对应 kit CSS](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/packages/openagent-plugin-kit/src/renderer/components.css#L2130)、[搜索兄弟卡片并改 class](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/components/BartThreadGeneration.tsx#L342)、[遍历摘要内部文本](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/components/BartThreadGeneration.tsx#L508)。

运动运行时把 Provider logo 位置写成固定数值；Generation 用 CSS selector 找卡片、隐藏卡片、读取摘要文本末尾。它们需要知道其他模块的 DOM 层级和样式细节。

**变更扩散：** 调整 logo 尺寸、摘要结构或容器层级，需要检查 kit、Overview、Generation 和 Motion Session；错误可能表现为静默错位或降级。

**建议：** 扩展已有空间注册表，显式注册 status / excerpt-end 等锚点及可见性操作，由卡片提供实际元素或测量器；运动模块消费语义锚点。

### F14 · P3 · 按线程 store 已建立，App 仍订阅整个状态

**位置：** [App 全量订阅](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/App.tsx#L109)、[全量派生链](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/App.tsx#L187)、[Overview 集合派生](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/components/ConversationOverview.tsx#L276)、[按 ID hooks](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/renderer/src/renderer-store-context.tsx#L37)、[catalog / content revision](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/shared/renderer-store.ts#L19)。

Bart 自身流式更新也会更换 threads 数组，并重新派生 Agent 集合、标签和筛选结果。根组件还协调导航、附件和动画，许多职责共享同一刷新频率。已提供的按 ID hooks 和目录版本在生产调用链中未发挥预期作用。

**建议：** App 只订阅导航与全局设置；Bart、详情、卡片按 ID 订阅；Overview 目录 / 标签用独立 selector。筛选若依赖 observation，必须明确纳入对应失效条件。

**不夸大性能问题：** 仓库 [既有 benchmark](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/benchmarks/renderer-results.json#L158) 的 48 线程数据记录 Overview update P95 约 1.4–2ms、background 约 0.5ms；WeakMap / memo 已减少未变卡片的重复投影。本项说明残余 O(N) 变更扩散，不证明当前已卡顿。

### F15 · P3 · OpenAgentService 同时是 Bart 协议 adapter 和 Thread 用例实现

**位置：** [Bart tool schema](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L2010)、[UI readThread](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L757)、[Bart readThread](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L2208)、[Bart 删除完整生命周期](https://github.com/xinyuan0801/OpenAgent/blob/f3230c5a36446b8a1985f99b6b5b29a0be8cb6da/apps/desktop/src/main/openagent-service.ts#L2256)。

UI / Bart 的 read、interrupt、respond 各有平行路径，重复排队、handle 打开和 workspace admission。bartDeleteThread 则直接承担删除认领、取消、排队、dispose、状态提交和 worktree 清理。协议适配没有止于解析和调用统一用例。

**后果：** 调整“读取前验证哪些事实”需要同步改多个入口；新增协议入口难以复用一个独立删除用例。这里的依据是重复职责和资源生命周期，不是该文件有 4,474 行。

**建议：** Bart adapter 负责 schema、JSON 编解码；ThreadCommands / ThreadLifecycle 拥有 read / send / respond / interrupt / delete 的统一实现；保留调用者不同的授权与取消语义，不要机械合并。OpenAgentService 收敛为组装和跨用例协调入口。

## 推荐实施顺序与目标边界

**第一阶段：先修行为，固定不变量。** 修 F01–F05。为附件存活、按 ID 消息完成、Claude 终态一致性、视觉失败不阻断状态、Runtime 与 Store 接受集合一致，分别补最小高价值回归。先避免资源丢失与错误状态继续产生。

**第二阶段：解除持久化和执行控制耦合。** 处理 F06–F08，并在 F15 中抽出线程用例。先把报告大内容从全量快照中分离，再处理线程持久化单元与配置版本；不要为了重构一次替换所有存储和并发机制。

**第三阶段：让包边界与运行时能力一致。** 处理 F09–F13，显式注入运行环境、Renderer 能力和几何锚点；给插件私有模型保留足够语义；最后按当前 benchmark 的相同场景评估 F14 的收益。

| 建议模块 | 应拥有 | 不应拥有 |
| --- | --- | --- |
| contracts | DTO、能力接口、公共结构校验 | 路由政策、产品提示词、配置 I/O |
| Bart policy / application | 通用 settings 工具组装、评测建议上下文、系统上下文政策 | 原生消息协议、附件 GC |
| ThreadCommands / Lifecycle | 生命周期、执行协调、资源释放 | UI / Bart 的 JSON schema |
| AttachmentRepository | 附件实体、Thread 引用、回收 | 仅从 Bart 文本推断全应用引用 |
| Provider runtime | CLI / wire 协议、原生 item identity | Renderer 对字符串约定的反向猜测 |
| Provider shared model | 单一状态模型、确定性 reducer / projection | 两份独立可变的当前状态 |
| Renderer store / sync | 权威 patch 接受与恢复 | 成功提交所必需的动画 |
| Overview / motion | 展示投影、锚点消费、动画 | 持久状态提交的决定权 |
| plugin-kit | 通过显式能力复用的实现 | Desktop 全局变量和启动政策 |

## 保留项与未升级项

- 保留 generated registry 与三插件包隔离。这些边界在已解析的 import 图中成立，无需为本次问题改成动态插件系统。
- 保留 opaque sessionState。Core 不应为修 F02 / F03 开始解释各提供商私有消息；修复应落在插件内部状态模型。
- 不以 contracts 高扇入、transport 长文件或出现重复代码本身判错。公共契约被广泛依赖是合理现象；是否同时承载不相关变更才是重点。
- Claude / Codex Bart 引用 main/catalog 的纯校验函数，造成目录层的双向依赖；可顺手把纯校验放入 shared，但未发现文件级循环初始化故障，优先级低于本报告的行为缺陷。
- OpenCode 保留 interaction / request 两种内部事件形态与重复响应入口，是后续清理候选；未证明当前用户故障，不列入优先修复项。
- 历史 SIMPLIFICATION_REPORT 描述的是过去基线，部分名称和结构已变化。本次结论以当前源码为准。
