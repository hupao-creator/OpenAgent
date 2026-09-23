# Bart system prompt 消融：真实 Codex `gpt-6-luna`

日期：2026-09-23。先测量 Bart 提示词各固定段落的行为影响；实验期间未修改正式提示词。随后按用户要求删除其中两段及同义工具结果提示。没有创建 PR。

## 方法

- 使用 `tests/bart-prompt-ablation.mjs` 启动真正的 Electron headless、OpenAgent Service、Codex Harness 和 Codex CLI；没有 Mock LLM。每个样本使用全新 user-data、OpenAgent home 和 Codex profile。Codex profile 临时复制现有登录凭据，结束时删除副本。原生会话证据确认 Bart 和成功创建的目标 Thread 均使用 `gpt-6-luna`。
- 所有样本固定 `effort=low`，Bart host 和 target 只开放 Codex，关闭自动干预。由于本机 Codex runtime 不支持项目默认的 `approve-for-me`，全部生成副本统一使用 `ask-for-approval`；该差异在各组间保持一致。用户任务不触发权限请求。
- 从同一构建产物复制主进程 bundle，每次只删去一段 Bart 指令：委派句、Core 工具专用句或执行契约。工具绑定、schema、上下文与默认路由说明不变。`no_execution_contract` 仅删 system prompt 中的契约，`openagent_thread_start` 结果里重复的派发提示仍保留。
- 两种用户请求：A 为普通算术请求「请计算 1729 × 37，并告诉我结果。」；B 明确要求创建独立 Agent Thread、使用临时工作区且不传 `cwd`。每组各 2 次。B 组中 2 次因 Codex 原生 sqlite 初始化失败，之后以相同配置另补 4 次。原始运行共 20 次，其中 18 次获得有效模型结果。

## 结果

### A：普通请求

| 条件 | 有效样本 | 尝试 `thread_start` | 成功创建 Thread | 正确结果 |
| --- | ---: | ---: | ---: | ---: |
| 原始提示词 | 2 | 1 | 0 | 2 |
| 删除委派句 | 2 | 0 | 0 | 2 |
| 删除 Core 工具专用句 | 2 | 0 | 0 | 2 |
| 删除执行契约 | 2 | 1 | 1 | 1 |

原始提示词下的一次委派把 Bart 自己的工作目录填进 `cwd`，Core 以「Agent Thread 不能使用 Bart workspace」拒绝。另一次 Bart 直接回答。删除执行契约的一次成功委派，另一次直接回答且把结果写错为 64,973。此任务太简单，不能单独判断委派策略是否有效。

### B：明确委派请求

| 条件 | 有效样本 | 成功创建并完成 Thread | 工具错误样本 | Bart 最终数值正确 |
| --- | ---: | ---: | ---: | ---: |
| 原始提示词 | 2 | 2 | 0 | 2 |
| 删除委派句 | 3 | 3 | 0 | 1 |
| 删除 Core 工具专用句 | 3 | 2 | 1 | 2 |
| 删除执行契约 | 2 | 2 | 1 | 0 |

工具错误详情：删除 Core 工具专用句的一次，Bart 为 `gpt-6-luna` 请求不支持的 `minimal` effort，Thread 未创建；删除执行契约的一次，Bart 先发了参数无效的 `thread_start`，随后重试成功。所有成功创建的目标 Thread 都是 `gpt-6-luna`。目标模型有时把 `1729 × 37` 算成 64,073，Bart 随之转述；算术正确率混入了目标模型随机性，不能归因于某一段 Bart prompt。

## 解释与下一步

1. 普通小任务即使保留「Delegate work」也可能由 Bart 自己回答；该句不是严格的委派约束。用户明确要求委派时，删除该句的 3 次有效样本仍全部委派成功。
2. 删除「只用 Core 工具」句后，独占工具绑定仍在运行时强制执行；本实验没有观察到它赋予 Bart 原生工具。单次无效 effort 是模型选择失误，样本量不足以断定由该句引起。
3. 删除 system prompt 的执行契约后，工具结果中的同义提示仍存在，因此这是**部分消融**。观察到一次额外的无效 `thread_start`，没有观察到明显轮询；不能据此断言执行契约可删除。
4. 目前没有证据支持直接删去任何固定段落。后续应使用更贴近真实协调工作的任务，固定目标 Thread 的确定性结果，并分开测「是否委派」「工具参数有效性」「派发后是否多余轮询」「最终答复质量」。

## 复现与证据

当时的实验入口是 `node apps/desktop/tests/bart-prompt-ablation.mjs <全新输出目录>`，可用环境变量 `BART_ABLATION_MODEL`、`BART_ABLATION_EFFORT`、`BART_ABLATION_REPEATS`、`BART_ABLATION_TASK`、`BART_ABLATION_VARIANTS` 控制。随后 Bart 的两段指令与同义工具结果提示按用户要求删除；脚本已改为以删除后的 prompt 为基线，保留委派句消融。上表反映删除前的历史运行，不能用当前脚本逐项复刻。每次运行的 `results.json`、各样本 `state.json`、`headless.log` 和原生 debug log 保留在输出目录。此次证据位置：

- `apps/desktop/out/bart-prompt-ablation-2`：任务 A。
- `apps/desktop/out/bart-prompt-ablation-explicit`：任务 B 原始运行。
- `/tmp/openagent-bart-prompt-ablation-rerun`：任务 B 的环境故障补跑及 Core 工具组复测。

输出目录在本机，未纳入 Git；其中的 `auth.json` 临时副本已删除。此次是探索性小样本实验，不提供统计显著性结论。

## 删除后的单次 smoke test

删除指定的两段 system prompt 和同义的 `nextAction` 工具结果提示后，重新构建主进程，以 `gpt-6-luna` 运行一次真实 headless 请求：创建独立 Thread 返回固定字串 `READY-7429`。目标 Thread 完成，Bart 最终答复正确。Bart 在**同一个 Execution**中依次调用 `openagent_thread_start`、`openagent_thread_status` 和 `openagent_thread_read`；这说明去掉派发后等待提示，至少在这一样本中出现了额外的即时查询。单次观察不估计发生率。证据位于 `apps/desktop/out/bart-prompt-after-removal/results.json` 和对应 `baseline-1/state.json`。
