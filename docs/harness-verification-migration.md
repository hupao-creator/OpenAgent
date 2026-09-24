# Harness 验证资产迁移映射（issue #197）

除「当前运行入口」外，本文保留的是 2026-09-12 的迁移记录。2026-09-24 清理后，
普通单元/DOM 测试及评分低于 8 分的 PBT 已删除；下文的旧测试路径和验证结果属于
历史证据。当前套件范围见 [PBT 治理](../apps/desktop/docs/property-governance.md)。

本次把 Harness 模块化从生产代码延伸到测试与开发工具：宿主策略以能力/行为角色表达，
插件专属验证资产归入所属 `packages/harness-<id>/`，原生验证知识集中到各 Harness 的
测试 Adapter（`@openagent/harness-<id>/test-support`）。基线是 OpenCode 移除（#196）
之后的 `cb347c8b`，全程未重新引入 OpenCode。

## 迁移时的归属规则（历史）

| 保证类别 | 归属 | 位置 |
| --- | --- | --- |
| 宿主策略（Bart Host 资格、可用性探测语义、目标隔离、设置页宿主行为） | Desktop 宿主测试，角色化表达 | `apps/desktop/tests/openagent-service-harness.test.ts` 等 |
| 纯能力谓词（`canHostBart`） | 共享契约 | `packages/openagent-contracts/src/harness-descriptor.ts`（Desktop `shared/harnesses` 转出） |
| 跨插件的组合契约（composition binding、provider-neutral 设置壳、telemetry 边界契约） | Desktop 共享套件 | `apps/desktop/tests/harness-execution-capabilities.test.ts`、`plugin-settings-isolation.test.ts`、`bart-plugin-telemetry.test.ts` |
| 只对某个 Harness 成立的保证（协议、状态、权限、传输、telemetry payload） | 所属插件包 | `packages/harness-<id>/tests/` |
| 原生协议事实（原生工具名、权限参数、会话/模型证据提取、录制参数、场景方言） | 所属插件包测试 Adapter | `packages/harness-<id>/src/test-support/index.ts`（`./test-support` export，生产代码禁止导入） |
| 共享测试 fixture（会话状态适配、open context、角色派生、Adapter 契约/加载器） | 测试专用包 | `packages/test-kit/`（`@openagent/test-kit`，仅测试依赖） |
| property 测试治理（预算、种子、回放） | Desktop property 治理（M9） | `apps/desktop/tests/property/`（本期不迁移） |

## 一、宿主规则去品牌化

`apps/desktop/tests/openagent-service-harness.test.ts`：

- fixture 组合按角色构建：`baseFixtureRoles`（由 `@openagent/test-kit` 的
  `deriveFixtureRoles` 从生成 registry 描述符派生）→ host 角色挂行为丰富的宿主
  fixture、nonHost 角色挂最小 fixture 并被剥掉 `exclusive` 工具模式
  （`stripBartHostCapability`），其余 id 用通用 task fixture。角色是从能力推导的
  行为位置，不再是「OpenCode 换成 Claude」式选角。
- 四条宿主规则（显式指定不支持 Host 被拒且不探测、不支持 Host 即使 CLI 可用也不被
  自动选中、被持久化的不支持 Host 被无探测替换、无 Host 能力的 provider 保留为普通
  目标）不再出现任何插件 id；期望的探测集合直接用共享谓词 `canHostBart` 计算。
- 组合变体验证（AC「两组合法 composition 的增加/移除验证」）：同一套规则在
  `hostPolicyVariants()` 产生的每个合法组合下各跑一遍——默认组合，以及（当 registry
  有两个 host-capable Harness 时）「宿主角色移至另一个 capable id」变体：一个 id
  被移除宿主能力、另一个被赋予，即以能力形式完成增加/移除。变体由 registry 重新
  派生，registry 变化时规则正文与断言零改写；两个变体下用例集合与断言完全相同，
  未减少任何用例。
- fixture 内部的品牌词（`codex-test`、`Targeted Codex work`、会话 schema 串等）全部
  改为角色派生；`trace.codexUnavailable` 改名 `hostUnavailable`。
- 保留少量真实组合集成测试中的具体 id（如 `main.codex.resolveThreadSettings` 的
  Bart 设置解析链路、演示用 metadata 标题断言）；它们验证真实注册组合的连通性，
  与宿主策略明确区分（见下表「保留」项）。

## 二、混合套件拆分与插件资产迁移

### 新增的插件专属测试（按保证归属）

| 新位置 | 保证 | 来源 |
| --- | --- | --- |
| `packages/harness-codex/tests/codex-execution-capabilities.test.ts` | Codex 探活不加载展示层/模型目录、自动探测、不可用+取消、Codex runtime 与进程级 headless 策略隔离 | 原 `harness-execution-capabilities.test.ts`（`git show cb347c8b:apps/desktop/tests/…` 可考） |
| `packages/harness-codex/tests/codex-settings-prompt.test.ts` | Codex promptSettings 保留 source model/executable、effort 收敛 low | 原 `plugin-settings-isolation.test.ts` |
| `packages/harness-codex/tests/codex-bart-telemetry.test.ts` | Codex 原生 usage 归一化、账本写入、unknown/error 区分 | 原 `bart-plugin-telemetry.test.ts` |
| `packages/harness-claude/tests/claude-execution-capabilities.test.ts` | Claude 探活/自动探测/不可用+取消、installer 路径回退、transport 显式 provider 注入无环境泄漏 | 原 `harness-execution-capabilities.test.ts` |
| `packages/harness-claude/tests/claude-settings-prompt.test.ts` | Claude promptSettings 保留身份、剥离 Thread 工具权限 | 原 `plugin-settings-isolation.test.ts` |
| `packages/harness-claude/tests/claude-bart-telemetry.test.ts` | Claude 原生 usage 归一化、DeepSeek 余额精确与官方 host 限定 | 原 `bart-plugin-telemetry.test.ts` |
| `packages/harness-pi/tests/pi-execution-capabilities.test.ts` | Pi 探测自动解析可执行文件、版本握手失败显式不可用 | 新增（Pi 的 probe 契约此前无专属回归） |
| `packages/harness-{codex,claude,pi}/tests/*-native-model-evidence.test.mjs` | 各家原生协议帧中的真实模型证据提取 | 原 `harness-injection-native-model-evidence.test.mjs` 的分 host 用例 |

### 整文件迁移（导入只触及包自身/共享测试 kit）

- Codex → `packages/harness-codex/tests/`：`codex-app-server-transport`、
  `codex-harness-plugin-v1`、`codex-harness-settings.dom`、`codex-main-regressions`、
  `codex-native-model`、`codex-permission-runtime`、`codex-read-behavior`、
  `codex-runtime-lifecycle`、`codex-session-state`、`codex-state-strict`、
  `codex-thread-injection`、`codex-thread-lifecycle`。
- Claude → `packages/harness-claude/tests/`：`claude-current-timeline.dom`、
  `claude-fork`、`claude-harness-plugin-v1`、`claude-harness-settings.dom`、
  `claude-session-state`、`claude-state-strict`、`claude-timeline-state`、
  `claude-tool-bridge-lifecycle`、`claude-transport-lifecycle`。
- Pi → `packages/harness-pi/tests/`：`pi-host-bridge`、`pi-prompt`、
  `pi-renderer.dom`、`pi-rpc`、`pi-settings`、`pi-thread`、
  `pi-host-isolation-native.mjs`（原生隔离脚本，路径已改指包内 dist）、
  `fixtures/fake-pi-rpc.mjs`（包内副本）。

### 保留在 Desktop 的（组合集成/宿主/共享治理）

| 文件 | 保留原因（集成依赖） |
| --- | --- |
| `codex-managed-worktree.test.ts` | 依赖宿主 `src/main/services/worktree-manager` |
| `codex-settings-resolution.test.ts` | 依赖宿主 `src/main/bart-v1/thread-creation` |
| `codex-interactions.dom.test.tsx`、`claude-interactions.dom.test.tsx` | 依赖宿主 renderer composition 与显示策略 helper |
| `claude-overview-interactions.dom.test.tsx` | 依赖宿主 overview 测试 helper |
| `claude-catalog-strict.test.ts` | 依赖宿主 `src/main/bart-v1/thread-creation` |
| `fixtures/fake-codex-app-server.mjs`、`fixtures/fake-pi-rpc.mjs`（旧路径副本） | 被宿主生命周期/目录/property 测试与 Electron 冒烟共用 |
| `property/native-harness.property.test.ts`、`property/pi-rpc.property.test.ts`、`property/native-claude-fixture.cjs` | property 治理（预算/种子/回放）集中在 `scripts/test-properties.mjs`；驱动 fixture 被共享属性断言复用 |
| `settings-dialog-plugin-validation.dom.test.tsx`、`bart-dispatch-feedback.dom.test.tsx`、`renderer-plugin-i18n.dom.test.tsx`、`core-renderer-shell-i18n.dom.test.tsx` | 真实注册组合的设置/派发/i18n 集成回归；依赖真实 registry 与渲染组合 |
| 删除项 | `harness-execution-capabilities.test.ts` 中 'returns unavailable on executable failure…'（与通用 `it.each` 逐模块用例重复，已并入包内版）；通用 `it.each(modules)` 探活三件套按「每模块 probe 契约属于插件」拆入包内（Pi 的 probe 是版本握手，本就不共享语义） |

### 当前运行入口（2026-09-24）

以下命令从仓库根目录运行：

- `pnpm test` 依次运行构建缓存集成检查和保留的 PBT；PBT 入口先构建包、生成注册表，
  再运行 Desktop 的 `tests/property/`，当前为 21 个文件、62 个 Vitest 用例。
- 单独运行 PBT：`pnpm test:properties`；扩大样本使用 `pnpm test:properties:explore`，
  回放使用 `pnpm test:properties:replay`，种子及路径参数见 PBT 治理。
- 类型检查：`pnpm typecheck` 先构建包再递归检查工作区；已有构建产物时可用
  `pnpm --filter @openagent/harness-<id> typecheck` 检查单个插件。
- 原生验收：`pnpm test:bart-headless`、`pnpm test:bart-headless:pbt`，以及
  `node apps/desktop/tests/harness-injection-native.mjs --host <id>`（真实 CLI）。

三个 Harness 包的普通单测及 `test` script 均已移除，插件相关的保留 PBT 统一通过
Desktop 的 property 入口运行。

## 三、原生验证知识收拢到测试 Adapter

- 契约：`packages/test-kit/src/native-adapter.ts`（`HarnessNativeTestAdapter`）——
  场景能力、最小权限/放权 Thread 设置、原生工具名与场景方言、录制 wrapper 参数、
  会话身份提取、原生模型证据解析、模型限定/别名规则、schema 变更是否轮换会话、
  missing-executable 失败场景设置。
- 加载器：`loadNativeTestAdapters` 从 Desktop 依赖集合派生注册集（与 registry 生成
  同源），经包 exports 解析 `./test-support`；缺 Adapter / id 不匹配 / 包未构建都是
  具名错误——通用 runner 不静默漏跑（`apps/desktop/tests/test-kit-native-adapter-loader.test.ts` 固定此契约）。
- 消费方改造：
  - `apps/desktop/tests/bart-headless/providers.mjs`：`PROVIDERS`/`HARNESS_IDS` 由
    Adapter 组合生成；profile/env 覆盖逻辑仍是宿主所有。
  - `apps/desktop/tests/harness-injection-native.mjs`：wrapper 参数、会话身份、
    schema 变更轮换断言、模型限定与别名判定、`nativeModelEvidence` 全部走 Adapter。
  - `apps/desktop/playgrounds/single-thread/capture-scenarios.mjs`：Harness 选择来自
    Adapter 注册集；权限/问答/后台/失败场景的提示词与参数由 Adapter 工具名 + 方言
    组合；Bart host 偏好由 `canHostBart(descriptor)` 派生；未知 id 是具名错误。
- 边界重申：Adapter 只适配真实系统；原生验收继续使用真实 CLI 与真实协议帧，
  期望值不来自被测输出。`scenarioCapabilities` 表达验收矩阵的有意选择子集
  （如 Codex 的 `question` 工具名仍由 Adapter 提供供场景采集使用，但不进验收矩阵）。

## 四、历史证据说明

`apps/desktop/docs/lifecycle-property-evidence.json` 中的测试路径是历史录制记录
（含实测耗时/退出码），与早前 OpenCode 相关条目同样按历史保留，不改写。

## 五、原生链路验证记录（本分支实际执行）

受影响的通用 runner 全部换接 Adapter 后，实际执行结果如下（2026-09-12，
worktree `wt/main-20260912-5`）：

| 链路 | 命令 | 结果 |
| --- | --- | --- |
| injection 驱动注册集/诊断 | `node tests/harness-injection-native.mjs --list` | PASS：host 清单由 Adapter 注册集派生（codex/claude/pi） |
| injection 驱动真实原生验收（Codex host） | `node tests/harness-injection-native.mjs --host codex --timeout-ms 420000` | **PASS**（exit 0）：真实 Codex CLI 完成 injection → follow-up → dispose/resume → 工具 schema 变更后的历史召回；原生 session/model 证据来自真实协议帧，干净通过后驱动按保留策略清理产物。期间发现并修复一个既有脱节：驱动的 `requested` 携带 `executablePath`，与 #124 收窄后的创建请求 schema 冲突（wrapper 路径改走宿主所有的 `merged`） |
| bart-headless 矩阵单测（plan/profile/environment/process/workspace） | `pnpm exec vitest run tests/bart-headless-*.test.mjs` | PASS：Adapter 组合的 `providers.mjs` 行为不变 |
| Adapter 契约与加载器诊断 | `pnpm exec vitest run tests/test-kit-native-adapter-loader.test.mjs`（vitest .ts） | PASS：注册集 = 依赖集；缺 Adapter 是具名错误 |

**未验证项（明确列出，不报告为通过）**：`pnpm test:bart-headless` 全矩阵与
`--host claude/pi` 的完整原生验收需要真实模型调用（产生真实 API 花费）与更长的
执行窗口，本分支未自动执行；claude/pi 的 Adapter 解析逻辑由包内原生状态样本单测
（`*-native-model-evidence.test.mjs`）与 --list 诊断覆盖。建议合入后按
`pnpm test:bart-headless` 与 `node tests/harness-injection-native.mjs --host claude`
各补一次完整记录。
