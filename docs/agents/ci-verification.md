# CI 验证

验证由 GitHub Actions 的 `verify` workflow 执行，运行在 GitHub 托管的 macOS runner 上：
按 PR diff 分级选择检查，在 CI 的检出目录内执行，并把 `verify` check run 的内容写进证据；
check run 本身由默认分支上的发布者提交，见[发布 check run](#发布-check-run)。
仓库没有本地验证入口，`pnpm verify` 已移除；本机只保留 `pnpm lint` 这类快速信号和
husky pre-commit 钩子。

## 触发与执行

`.github/workflows/verify.yml` 由 `pull_request`（opened / synchronize / reopened /
ready_for_review）触发。原生报告、生命周期和 Bart 检查要启动 Electron，因此使用
macOS runner；同一 PR 的并发运行由 `concurrency` 取消，只有最新提交的结果被保留。

workflow 检出 PR head（`fetch-depth: 0`，以便计算 merge-base），以 PR 的 base SHA 作为
比较基线，按[分级规则](verification-scope.md)在同一次检出内执行必跑步骤。与旧版本一致，
验证的是 PR head，不构造与 base 的临时合并提交。

base SHA 在执行时通过 `VERIFY_PR` 读 PR 的当前 base，事件负载里的 `VERIFY_BASE` 只是取不到
时的兜底。base 分支前进不会触发任何 `pull_request` 事件，若沿用入队时捕获的值，重跑那次
workflow 只会再验证一次旧 base，PR 会一直卡在过期证据上；读实时 base 后，Actions 页面上的
re-run 就是可用的恢复路径。

check run 挂在 PR head 上，也就是这次真正验证的那个提交。曾经挂 merge commit，但事件负载里的
`pull_request.merge_commit_sha` 在 `synchronize` 时仍指向上一个 head，check run 会落到门禁不读的
SHA 上；head 是唯一稳定的落点。base 前进后 check run 仍在，但证据行里记录的 base 已经过期，
门禁因此要求重跑而不是放行。

## 检查范围

`VERIFY_BASE` 到 `VERIFY_HEAD` 的完整差异决定检查种类与包范围，规则见
[分级规则与验收](verification-scope.md)。混合改动取并集，包源码改动沿工作区反向依赖传播，
有未分类改动时全量。需要预览计划时推送分支后查看 workflow 日志与 `result.json`。

全量检查依次包括：

1. 安装锁定依赖，记录 Node、pnpm、TypeScript、操作系统和架构。
2. 构建插件并生成注册表，检查生成结果与提交一致。
3. 完整类型检查、lint 和现有回归测试（`pnpm typecheck`、`pnpm lint`、`pnpm test`）。
4. 真实 Chromium 验证插件源码更新到浏览器和 Main bundle、CSS 热更新、源码恢复及开发进程退出。
5. 生产构建（`pnpm build:bundles`）。
6. 真实 Electron 报告隔离与应用生命周期回归。
7. 检查没有遗留源码变更。

热更新检查在 `scripts/verify-development.mjs`，只在检出内临时修改 fixture 源码并恢复。
任何必跑步骤失败都会停止后续步骤、保留日志并让 job 失败，不会报告成功。
Bart 隔离套件不在 CI 中运行：它需要 1180×780 的原生窗口，托管的 macOS runner 只有
1024×653，坐标、合成手势和准入预算都无法成立。该套件只在真机手动执行，见
[Bart 隔离测量](bart-isolation.md)。

## 证据与门禁

每次运行把证据写到 `$RUNNER_TEMP/verification-evidence`，并在结束后上传为
`verification-evidence` artifact（保留 14 天）：

- `summary.md`：受检 SHA、分级计划、必跑/跳过步骤、工具版本、结果和耗时。
- `result.json`：完整变更路径、影响工作区、选择理由、结构化结果、步骤命令、日志 SHA-256、
  `publication` 字段（本轮恒为 `deferred`）及错误。
- `logs/`：每个步骤的完整输出。
- `plan.json`、`test-selection.json`、`build-cache/`：分级计划、测试选择和构建缓存证据。
- `check-run.json`：`verify` check run 的名称、受检 SHA、结论和摘要，供发布者读取。

`verify` check run 的 `output.summary` 以 `scope-v2:<full|scoped>:<受检 SHA>:<base SHA>`
开头，门禁据此校验。`scripts/pr-gate.py` 的 `checkVerification` 要求：

- HEAD 上存在名为 `verify` 的 check run，且已完成且结论为 success
  （尚无该 check run 时按 pending 处理，等待 CI 启动）；
- 证据行中的受检 SHA 与 base SHA 与当前快照一致（PR 新增提交或 base 前进后必须重跑）；
- 快照采集期间 HEAD 与 base 未变化，且没有其他失败的 status 或 check run。

条件与命令见 [PR 门禁](pr-gate.md)。如果未来配置合并保护，使用 `verify` 作为检查名称。

## 发布 check run

`verify` job 不建 check run，它只写下 `check-run.json`。它跑的是 PR 自己的代码，所以
permissions 只有 `contents: read`：改写验证脚本的 PR 可以伪造 payload 的内容，却拿不到任何
能写 check 的凭据，写不出 check run。`GITHUB_TOKEN` 仍在环境里，但只用于读 PR 的实时 base。

check run 由 `.github/workflows/verify-publish.yml` 创建。它由 `workflow_run` 触发，因此 GitHub
总是从默认分支读取该 workflow、并检出默认分支的 `scripts/verify-publish.mjs`：持有
`checks: write` 的代码永远来自受信任分支，不会是被审查分支里的代码。

发布者只做一件事：把 artifact 里的 `check-run.json` 贴到事件给出的受检 head 上。受检 SHA 和
仓库取自事件而不是 artifact，证据行的 head 与之不一致时拒绝发布，因此一份证据不能改挂到别的
提交上。证据里的 base 不参与这一步校验：那是运行时解析出的实时 base，base 分支前进时它会与
事件负载里捕获的那个不同，所以 base 与当前快照是否相符由门禁判断，不由发布者判断。
被 `cancel-in-progress` 取代的运行没有 artifact，发布者静默跳过，由上一次运行负责回写；
缺少 payload 同样不发布，门禁保持等待而不是放行。

残余风险：PR 仍然控制自己的测试脚本，可以写出内容不实的 payload，发布者会照贴。这次收紧的是
写 check 的凭据路径——PR 不再能自行发布 check run，也无法把结果挂到别的提交上——不是测试本身。

## 失败与排查

失败会在注释中给出出错步骤的日志尾部，完整日志在 artifact 里。重跑方式：推送新提交，
或在 Actions 页面 re-run 失败的 workflow。fork PR 的 head 提交不属于本仓库，发布者不会为它
写 check run，检查会执行但门禁保持拦截，这是有意的：外部贡献需要在受控环境中验证。

原生检查依赖 macOS 上的图形登录会话。若托管 runner 无法启动 Electron，对应步骤会失败
并给出日志，此时应调整 workflow（例如拆分原生检查），而不是放宽门禁。

GitHub 上任何其他失败的 status 或 check run 同样会拦截合并，`verify` 不是唯一来源。
历史 Actions 失败仍显示在旧 PR；不能把“未执行”改写成成功。
