# PR 门禁脚本

机制层在 `scripts/pr_gate_lib.py`（snapshot 读模型、审查状态机、轮询、请求、合并执行，零策略）；策略与 CLI 在 `scripts/pr-gate.py`。需要 Python 3.8 或更新版本（仅标准库）和已登录的 `gh`：读命令需要仓库读取权限，`request`/`merge` 需要评论与合并写权限。默认从当前仓库推断远端，可指定 `--repo owner/repo`。所有命令输出 JSON。

```sh
python3 scripts/pr-gate.py status 123        # 轻量读（无 threads/checks）
python3 scripts/pr-gate.py comments 123      # 读，含行内评论与讨论线程状态
python3 scripts/pr-gate.py snapshot 123      # 全量读模型（threads + statuses/check-runs + 轮数预算）
python3 scripts/pr-gate.py poll 123 --timeout 600 --interval 15 --settle 5
python3 scripts/pr-gate.py request 123       # 发起一轮审查
python3 scripts/pr-gate.py gate 123 [--only a,b] [--skip a,b]
python3 scripts/pr-gate.py merge 123 [--check] [--merge|--rebase]
```

每个命令只做一件事；`snapshot` 是其他命令的读模型原子。收集 threads 与 statuses/check-runs 时绑定最终读取的 HEAD，check-runs 同时读取 HEAD 和 PR merge commit（`verify` 挂在 HEAD；读 merge commit 是为了不漏掉挂在别处的检查），期间 HEAD 或 base 变化则整体标记 `unknown` 要求重试。`comments` 和 `poll` 额外查询讨论线程的解决和过期状态；行内评论保留路径、行号、commit、链接及同线程回复；所有列表分页读取。

`poll` 在状态或完成证据变化时即时向 stderr 输出简短 JSON 进展，最终完整结果仍写 stdout，便于重定向保存而不混入进展记录。若当前 HEAD 的完成摘要已到、但结果格式未识别，会明确输出 `unrecognized-result`；超时结果也保留 diagnostic，避免把识别失败误当成审查仍在运行。

## 门禁策略（GATE_CHECKS）

GitHub CLI 可通过 `OPENAGENT_GITHUB_CLI` 指定为一个可执行文件（默认 `gh`）。使用 `ghw` 等账号包装器时，将其可执行入口传给此变量；脚本仍执行相同的完整门禁，不改变审查或验证策略。若包装器是 shell function，可使用一个只转发参数的本地可执行脚本调用该函数。

`gate`/`merge` 按检查清单裁决：任一 blocked → blocked（退出码 1）；否则任一 pending → pending（退出码 2）；否则 ready（退出码 0）。清单是唯一策略落点：改拦截条件只改对应 check 原子，增删条件只改 `GATE_CHECKS` 映射，`--only`/`--skip` 可临时缩小范围。映射的键保留为下表中的检查名，用于命令参数和 JSON 输出。

| 检查 | pass | pending (2) | blocked (1) |
| --- | --- | --- | --- |
| checkPrOpen | open | draft | 非 open、已合并 |
| checkMergeable | clean/has_hooks/unstable | mergeable 未算出、state unknown、draft | 冲突或其他不可合并状态 |
| checkReviewInitiated | 至少发起过 1 轮 | — | 从未发起 review，先 `request` |
| checkReviewFlow | HEAD review 完成且完成摘要匹配；in-flight/stale 但总轮数或计费轮数耗尽（本地 review 兜底）；请求被 Codex 以额度用尽拒绝（refused，本地 review 兜底） | in-flight 或 stale 且仍有额度；submitted 但摘要未确认 | — |
| checkThreadsResolved | 全部线程 resolved | — | 任何作者（含 bot、含 outdated）的未解决线程，逐条列链接 |
| checkVerification | `verify` check run 成功，其 `scope-v2` 证据的受检 SHA 与 base 匹配当前快照，且不存在失败的其他 status/check-run | 尚无 `verify` check run（CI 可能刚启动）、该 check run 仍在运行，或其他 status/check 运行中 | `verify` check run 结论非 success，或范围证据与当前 HEAD/base 不符，或其他 status/check-run 失败 |

轮次预算：完成的 review 只有无 P0/P1 findings 才消耗预算（`chargeableRounds`），产生 P0/P1 的轮次免计费；`requestCount` 是历史请求总数，同时用于判定至少发起过一轮和最多发起 5 轮（包括 P0/P1 和额度拒绝）。`requestsRemaining` 取剩余总轮数与剩余计费轮数的较小值。请求评论只信任仓库 Owner/Member/Collaborator——公开仓库里路人的 `@codex review` 不计入轮次也不进入请求状态。总请求达到 5 轮或计费轮耗尽（3 轮）后 `request` 拒绝发布（退出码 3，`rejected: true`）并提示改用本地 review；此时 `checkReviewFlow` 对 in-flight/stale 放行，未解决线程依然拦截。上一轮仍在飞行中时 `request` 同样拒绝（请求↔review 的关联依赖时间顺序，禁止叠加轮次）；发布前会重读一次评论以缩小并发窗口，但客户端无法完全消除竞态，挂起的轮次只能等待审查完成或人工介入。

额度拒绝（refused）：最新请求之后若出现 bot 本人发出的 "reached your Codex usage limits" 评论、且没有 review 回答，该轮被识别为 `refused`——provider 已明确拒绝，等待永远不会有结果，与 3 轮耗尽同样直接退回本地 review（`checkReviewFlow` 放行；无完成摘要，`merge` 走紧贴合并前的重查路径）。refused 轮不消耗预算，`poll` 检测到拒绝后立即返回（`state: refused`、`timedOut: false`、`observationStable: false`、`nextAction: gate`，退出码 0），随后用 `gate` 评估，额度恢复后若总轮数尚未达到 5，可重新 `request` 新一轮。识别只匹配 bot 原文，文案变更即回退为 in-flight（保守方向）；请求与拒绝之间的其他评论不影响识别。残余风险：拒绝若以 review 正文而非 issue 评论的形式出现，不会被识别，会按普通轮计费——目前观察到的拒绝载体是 issue 评论。

无问题轮可能没有 GitHub Review 记录，只以机器人本人发布的 `Codex Review: Didn't find any major issues.` 评论返回。脚本要求该评论同时包含 `Reviewed commit`、对应此前的可信请求，并与当前 HEAD 及完成摘要匹配；普通评论或点赞不构成完成证据。同一请求同时收到正式 Review 和结果评论时，以正式 Review 为准且不重复计费。评论形式的结果仍须经过相同稳定窗口和全部合并检查。

再次 `request` 前，上一轮必须有匹配的完成摘要，并重新观察 5 秒稳定窗口；评论或正式 Review 单独到达均不足以启动下一轮。迟到结果会重置窗口，HEAD、请求或 PR 状态变化会中止发起；发布前再次核对同一审查流。推送修复后可以用上一轮被审查的提交匹配其摘要，同时监视当前 HEAD，避免把旧轮迟到结果归入新请求。首次请求和明确的额度拒绝无需等待不存在的上一轮完成结果。此约束依赖通过 `request` 发起审查；外部直接叠加评论仍无法由 GitHub API 的时间戳可靠区分归属。

## 合并

`merge` 先跑一次 gate；存在完成摘要时，会在执行前观察 review 流一个 5 秒稳定窗口（两次指纹一致的观测，任何变化重置窗口），延迟到达的意见因此会在合并前暴露；无完成摘要的本地 review 兜底路径只做紧贴合并前的重查。随后执行 `gh pr merge --squash --match-head-commit <head>` 并回读确认合并落在同一 head；`--check` 只评估不合并；`--merge`/`--rebase` 切换合并方式。merge 总是执行完整 GATE_CHECKS，不接受 `--only`/`--skip`（那是 `gate` 命令的临时范围调整）。门禁未过时脚本拒绝执行——这就是 block merge 的实现方式。

## 边界与非目标

- 这是程序性门禁，不是 GitHub 保护规则：直接 `gh pr merge` 仍可绕过，由 AGENTS.md 明文禁止。
- 只有 PR 上的 review threads 计入拦截；仅存在于本地或 review 正文中的意见不在门禁内。
- verification 条件依赖 CI 的 `verify` workflow 发布 `verify` check run；推送分支后自动触发，也可在 Actions 页面重跑。
- 分级规则见 [按改动范围验证](verification-scope.md)，CI 细节见 [CI 验证](ci-verification.md)。缺少范围证据的成功需要重跑；base 改变后同样需要重跑。
- `settled`、退出码 0、空列表均不代表无问题；阅读 review 正文与行内意见是人工职责。脚本不解决线程、不改写 review。

## 测试

`python3 -B -m unittest discover -s scripts/tests -p 'test_pr_gate.py'` 使用模拟 GitHub 响应和时钟验证门禁，不访问远端；覆盖 `verify` 证据缺失、受检 SHA 或 base 不符、过期运行和新旧 check run 的选取。该测试集也纳入 `pnpm test:dev-scripts`。
