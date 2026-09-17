# Bart Thread Camera Playground

运行 `pnpm playground:bart-transition`，打开 [localhost:4181](http://127.0.0.1:4181/)。无需 CLI、账号或真实会话。

保留「穿过眼睛 + 好奇迎接」：Bart 先回神、后缩，再探身睁大右眼，让镜头进入真实会话。默认时长 1100ms，支持三分之一慢速、自动往返、回到起点、收起面板；`⌘/Ctrl B` 切换，`Esc` 返回。输入控件保持自己的快捷键。

复用生产 `ConversationOverview`、`BartThreadView`、`BartDock` 和 `use-camera-transition`。预热字体与 Markdown 时不锁定界面，封口阶段才固定几何与交互。专用动画 Worker 接收两页快照、真实 SVG 路径和完整演出，在关联 OffscreenCanvas 中自主绘制。主线程阻塞不会阻止镜头推进或到达终态。

页面快照最多 DPR 2、最长边 4096 物理像素，同时受窗口纹理预算约束。预热总预算 10 秒，封口预算 2 秒。预算不足、窗口变化、取消或图形故障时直接恢复目标页面；系统启用减少动态效果时直接切换。正常终态保留覆盖，直到 Host 提交真实页面并转交交互权。

当前阶段不提供暂停、进度拖动或从中间状态平滑反向；再次导航会安全中止旧演出并恢复最新目标。业务与输入草稿不由动画控制。

执行 `pnpm --dir apps/desktop test:bart-isolation` 验证真实 Electron 窗口的进入/返回及 2 秒、5 秒同步主线程阻塞。具体方法见[实测记录](../../docs/bart-motion-worker-evidence.md)。
