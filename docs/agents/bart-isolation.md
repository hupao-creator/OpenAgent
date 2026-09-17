# Bart isolation 的测量证据

`pnpm --dir apps/desktop test:bart-isolation` 串行运行真实 Electron 场景。
settings 专项可独立运行：

```sh
pnpm --dir apps/desktop exec vite build --config labs/bart/vite.config.ts
node apps/desktop/tests/bart-worker-isolation.electron.mjs --settings 5000
```

结果目录由 `BART_ISOLATION_OUTPUT` 指定，默认打印临时目录。settings 的
`settings.json` 保存预热、时钟校准、动作、阻塞边界、恢复窗口与原始帧 hash；
`outcome.json` 保存最终分类。不要并行运行原生采样、构建或其他高负载测试。

## 计时与对照

采集订阅在动作开始前挂接，持续跨过校准、动作和恢复。Lab 在触发动作前订阅
Performance marks，在 ready 后让两个 renderer rAF 提交初始层，随后在真正
busy loop 的入口/出口记录 renderer 绝对时间。Main 不再轮询 ready 后重新
挂接订阅，也不再用一次 IPC 的返回时刻反推动作起点。

原生回调仍使用 Main 单调时钟。五次往返中选择最小 RTT，以中点估计两边的
时钟偏移，半个 RTT 为不确定界。分析窗口两端扣除这个界。该映射只用于相关联，
不把 callback 到达时间声称为 presentation time。

独立绿色 WAAPI 标记与 dispatch 通过同一张原生图像采集。连续标记像素发生
变化的一张图，算一次合成器更新机会。产品连续重复的机会数才是冻结证据；
采集管线没有送来帧时，不能凭空补一个“产品停顿”。

每个动作前采样 1100ms（两个 dispatch 视觉周期）。host/target 还要求未阻塞的
真实 dispatch 至少有 10 个不同画面，且最长重复段不超过采样机会数的十分之一，
防止把冻结基线当成慢宿主。阻塞及恢复窗口的重复段预算是这次对照的三倍，
基线零重复时以一次机会计。产品画面停住而绿色标记继续走，会失败。

采集不足 20 次独立机会、观测窗口某个四分区不足校准采样密度的一半（至少两次），或短动作前四分之一
已经被 renderer 帧调度消耗，均不能证明隔离成立：退出 75，结果为
`environment-inconclusive`。完整验证保留该分类，GitHub status 发布 `error`；
门禁仍阻止合并。没有自动重试，也不把不可测量场景记成通过。

## 5000ms 场景的 flow 下界

虚线 dash 为 `[5, 7]`，每 1100ms 移动 24px，所以视觉图案每 **550ms** 重复。
host 反馈动画是 1050ms；本 fixture 的 target 操作取消 codex，反馈为 1600ms。
持续的 dispatch flow 不受这两个反馈动画的结束限制。

设动作 ready 的 renderer epoch 为 R，真正阻塞开始为 B，结束为 U：

- flow 开始：`max(R + 900, B + 0.08 * blockMs)`。
- flow 结束：`U - 0.015 * blockMs`。
- 再从两端扣除时钟映射不确定界。

5000ms 下，正常 B-R 约 10–20ms，窗口约 **4.035–4.045 秒**，覆盖约 **7.3 个
视觉周期**。实际 native capture 约 30Hz，预期约 **121 次采样/连续变化**；
显示器的 120Hz 不能拿来假设收到 484 张图。周期重复和栅格量化会使不同 hash
数量小于变化次数，不能把两者混淆。

`unique >= 10` 是已承认充分采样后的最低视觉丰富度：每周期约有 16 次采样机会，
整窗有七个以上周期。它单独不足以证明持续更新；最长重复机会数还必须满足相对
对照预算。解除阻塞、native 状态恢复后，先承认三张独立合成器图像，再独立采样
**1100ms**。关闭页面可能重建采集管线；这里仅等待独立标记，不等待产品像素更新，
所以永久冻结的 Worker 不能借此逃过验证。同时检查 renderer Canvas2D 负对照
恢复、dispatch 的十个不同画面及持续更新，不能用阻塞前的变化抵扣恢复失败。

负对照必须在充分采样的阻塞窗口内只有一个 hash；零样本不能证明它冻结了。
另外检查 renderer 实际阻塞时长；阻塞未执行是失败。时钟误差界不约束图片年龄，
若已证明阻塞执行但负对照图片仍跨越边界，则采集证据不可用，不能归罪产品或通过。
短动作仍须有至少六个不同原生画面，最终 native 状态、交互所有权和纹理释放
仍然是产品断言。

## 准备预算与 handoff

产品预算保持原值。settings 跨页 flight 显式传入的是 **250ms 总准入预算**，
而不是 `prepareWithinBudget` 默认的 10000ms。`preparing: borrow` 出现在引擎
图片解码之后，包含 Worker 角色栅格准备；该文案不能证明图像解码用了十秒。

测量前有一次明确的 open/close 冷启动设置周期；它检查 native 页面和资源安全
恢复，不算 isolation 通过。如果测量动作被产品预算明确拒绝，也必须先验证安全
回退，再以不可测量退出。其他准备错误、没有 ready/skip 事件及恢复错误仍失败。
超时回退的确定性产品行为继续由 scene-host / cross-page 单元测试约束。

handoff 的 open、ready 后 70ms close 也在 renderer 内安排，避免往返延迟令
预期中间状态在物理上无法出现。第二次反转订阅重定向动画的 `finished`，检查覆盖层可见、
动画完成且页面仍 closing，并在同一个本地回调中 reopen。Main 等待持久证据，
不再跨 IPC 轮询一个可能只存在几十毫秒的状态。

## 故障验证

故障必须注入真实产品行为，不能只伪造测试返回值。例如在 dispatch painter 的
source relocation 后记录 `freezeAt = performance.now() + 2000`，绘制时使用
`now = Math.min(now, freezeAt)`。这会先产生足够多不同帧再永久冻结虚线，独立
WAAPI 标记仍更新，必须以产品失败退出 1。验证后恢复源文件并重建 Lab。

回归单测同时覆盖永久冻结基线、先更新再冻结、仅恢复阶段冻结、采集缺失与早期
采样突发。真实 Electron 连续验收必须在同一个提交上至少运行六次，保留每次
退出状态；环境不可测量不能计入通过次数。
