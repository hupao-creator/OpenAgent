# 按改动范围验证

## 需求与验收

验证应根据完整 PR diff 选择检查，减少与变更无关的测试、开发热更新和原生应用启动。
采用激进分级：文件归属决定检查种类，工作区依赖图决定类型检查和回归测试的包范围。
混合改动取并集；不能确定影响范围时执行完整验证。检查计划必须可以预览和追溯，
任何必跑步骤失败或缺失都不得发布成功。测试文件选择规则见下方专项说明。

## 使用

```sh
pnpm verify --pr 123 --plan          # 只输出计划，不执行检查或发布状态
pnpm verify --pr 123 --publish       # 自动按 PR merge-base 到 head 的完整差异分级
pnpm verify --base origin/main      # 本地已提交 HEAD，相对本地 origin/main 的 merge-base
pnpm verify --ref <sha> --base <ref> # 指定受检提交和比较基线
pnpm verify --pr 123 --full --publish
```

`--pr` 获取 PR 的 head 和 base，不能用 `--base` 覆盖 PR 基线。缺少本地比较基线时
继续全量，避免把「最后一个提交」误当成整个分支的改动。`--plan` 可在有未提交改动时运行，
但只分析已提交目标；实际执行仍要求干净 checkout。无法解析基线或 merge-base 时失败。

## 选择规则

| 改动 | 验证范围 |
| --- | --- |
| 明确文档目录内的 Markdown、明确 README/指南 | checkout 完整性检查，无依赖安装、产品测试 |
| PR 门禁代码或测试 | Python 门禁回归 |
| 开发工具测试、开发应用安装/打开脚本 | 开发脚本回归；安装/打开脚本另做 Node 语法检查 |
| dev 入口、Vite server host、desktop watcher | 桌面类型检查/测试/构建、开发脚本回归、Chromium 热更新 |
| 桌面 renderer 源码（含 CSS） | 桌面类型检查/测试/构建；路径含 appearance/theme/window 时追加原生生命周期检查 |
| 桌面 main/preload/shared 等源码 | 桌面类型检查/测试/构建、报告和生命周期原生回归 |
| 包源码 | 该包及依赖它的工作区的类型检查和测试；影响桌面时追加构建，非 renderer 源码再追加原生回归 |
| 工作区内 `.test.*` / `.spec.*` | 所属工作区类型检查和测试，跳过生产构建、热更新和原生回归 |
| 独立报告/生命周期 Electron 测试入口 | 构建及对应原生回归 |
| Bart、Overview 相机、协调者设置页 renderer 源码，或隔离验收入口 | 追加 `bart-isolation`：独立构建 Lab，串行运行真实 Electron 的 2 秒/5 秒阻塞与交接检查 |
| manifests、锁文件、构建配置、验证器及其测试、共享测试 fixture/helper、其他未分类路径 | 全量 |

产品验证会安装锁定依赖、构建全部包并生成/核对 registry、执行全仓 lint。
完整验证包含 `bart-isolation`。所有原生运行时检查在构建、单测完成后串行运行，避免测量受到并行重负载干扰；该步骤需要 macOS 原生窗口环境。
这些准备步骤仍共享，缩小的是类型检查及回归测试的工作区集合和昂贵运行时步骤。
包依赖图来自受检提交，包含 dependencies、devDependencies、peerDependencies、optionalDependencies，
按反向依赖传递闭包选择消费者，因此修改 contracts/test-kit 会扩大范围。

纯测试修改不会向消费者传播；共享测试支撑源码（例如 test-kit/src）按产品源码传播。
重命名关闭相似度识别，新旧路径均参与；删除路径仍参与分类。未知路径及空 diff 全量。
规则是显式路径策略，不是完整程序依赖分析：若出现新的跨层行为，需要调整映射，或用 `--full`。

## 证据与门禁

`result.json` 保存策略版本、base SHA、merge-base、完整变更路径、影响区域、工作区、必跑/跳过步骤及理由。
摘要展示同一计划和实际执行结果。只有全部必跑步骤通过并清理检查成功，才可发布成功。
跳过的步骤显示为不需要执行，不伪装为已通过。

保留 `local/desktop-verification` context，成功描述为 `scope-v1:<full|scoped>:<base SHA>`。
门禁仍信任本地验证器发布的状态，不下载并重跑本地日志；它要求新版范围证据匹配当前 PR base，
且读取期间 head/base 一致。旧版无范围证据的成功状态不再放行，需要重新验证。
base 前进或 PR 改换基线后，即使 head 不变也需要重新验证；这仍是 head 验证，并非合成 merge 验证。

## 测试

使用真实临时 Git 仓库覆盖 merge-base、改名、删除、特殊文件名、无效基线。
纯函数测试覆盖分级并集、传递依赖、全量回退和步骤完成要求。
从 CLI 启动临时 checkout，使用替代包管理器验证轻量路径无安装、过滤工作区的命令、
步骤失败不会变绿以及 worktree 清理。Python 门禁测试覆盖成功证据缺失、过期和采集竞争。

```sh
pnpm test:dev-scripts
```

## 测试文件选择与并行

分级计划会附带每个工作区的 `testJobs`：

- 只修改测试：运行改动的测试文件。
- 修改本工作区 JS/TS 源码：使用 Vitest `related` 按静态导入及可解析动态导入选择测试。
- 已映射资源：气泡 CSS 映射到 reply lifecycle/navigation 两份 DOM 测试。
  这些测试覆盖 DOM/交互行为，不提供像素级视觉保证；证据中明确记录该限制。
- 跨工作区消费者、删除、声明文件、未映射资源：回退所属工作区完整测试集。
- 关联测试为空、没有实际通过的测试或执行失败：验证失败，不通过 `passWithNoTests` 放行。
  此时需查看覆盖缺口，或显式运行 `--full`。

工作区依赖从已准备好的包输出读取；消费者不依赖 Vitest 穿透 node_modules 追溯源码。
测试输出 JSON 和 `test-selection.json` 保留实际执行文件、测试数及选择理由。

| 阶段 | 并行关系 |
| --- | --- |
| 安装依赖、工具链、构建包、生成/核对 registry | 顺序执行，完成后才能启动产品检查 |
| 分级类型检查、lint、回归测试、需要时的 Chromium 安装 | 同时执行；类型检查和回归直接调用 tsc/vitest，不重复生成 registry |
| 全量类型检查、lint、Chromium 安装 | 同时执行；全量回归入口可能重建包，因此随后串行执行 |
| 开发热更新 | 独占运行，会临时修改源码及开发构建产物 |
| 生产构建 | 热更新退出并恢复源码后运行；不与使用相同 tsbuildinfo 的类型检查并发 |
| 报告、生命周期原生回归 | 保持串行，避免桌面应用测试相互影响 |
| checkout 完整性检查和清理 | 所有已启动任务结束后执行 |

中断信号会发送给所有活动进程组；某项失败后，等待同组其他任务退出再清理 worktree。
子进程读取不可变 `plan.json`，不读取并行期间持续更新的结果文件。
可添加 `--serial` 关闭上述并行，用于同一计划的耗时比较。

## 构建缓存

使用固定版本 Turborepo 2.10.12，将各 workspace 包构建及桌面的 main/preload/renderer
拆成独立任务。原有 `pnpm build` 仍包含应用类型检查；verification 已完成类型检查，
因此构建阶段调用 `build:bundles`，避免重复执行。

缓存位于 `git rev-parse --git-common-dir` 下的 `openagent-build-cache`，同仓库的临时
worktree 自动共用，移除 worktree 不删除缓存。只启用本地缓存，不上传远端。
输入包含包源码、依赖任务哈希、锁文件、构建配置、环境文件，以及 Node/pnpm 版本、
操作系统、CPU 架构和配置中声明的构建环境变量。

每次恢复前清理对应 dist、编译状态和桌面输出目录，避免旧文件残留。
同 checkout 的产物写入继续使用进程锁；不同 worktree 的输出目录互相独立。
registry 每次实际生成并与 Git 比较，不以缓存代替生成结果校验。

main/preload 的输入排除 renderer CSS；目标构建器同时拒绝 native bundle 导入这些 CSS，
避免缓存规则与实际依赖不一致。其余 renderer 源码仍纳入 native 任务输入，以覆盖现有跨层 TS 引用。
首次修改气泡 CSS，包和 native 任务可命中，renderer 重建；再次验证相同输入时 renderer 也可命中。

`--force-build` 禁止读取构建缓存（仍写入成功产物），用于冷构建对照或复核。
`--full` 决定验证范围，缓存读取由 `--force-build` 单独控制。
`result.json` 中的 `buildCache` 和 `build-cache/*.json` 保存任务哈希、命中状态及 Turbo 原始摘要。

```sh
pnpm verify --pr 123 --force-build
pnpm test:build-cache
```

缓存集成测试覆盖跨 worktree 恢复、残留产物清除、依赖传播和环境变量失效；该测试需要安装
依赖，纳入全量 `pnpm test`，不增加纯工具脚本验证的安装成本。

实时开发 watcher 使用 `OPENAGENT_LIVE_BUILD=1` 保留原位 TypeScript 增量编译和 CSS 覆盖，
不清空目录或恢复 Turbo 产物，避免活跃 Vite 观察到文件暂时消失。缓存恢复面向非实时构建；
完整 verification 中的热更新步骤仍实际验证这条开发路径。

重复构建在锁内比较 Turbo 任务 hash 和完整产物内容指纹；两者均未变化时保持文件原位，
证据记为 `UNCHANGED`，防止并行工作区测试读取期间再次恢复缓存。首次构建、输入变化或
产物损坏仍清理并恢复/构建，`--force-build` 始终绕过原位复用。
