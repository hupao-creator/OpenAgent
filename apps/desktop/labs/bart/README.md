# Bart Lab

Bart 是 OpenAgent 的任务协调助手。这个 Lab 用于预览 Bart 的角色形象与交互状态：常驻、输入、Question 和 Permission。

## 启动

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm lab:bart
```

打开 http://127.0.0.1:4177。该命令先构建 workspace 包并生成 Harness 注册表，再启动 Vite；无需启动 Electron 或登录模型服务。

`pnpm lab:bart:build` 执行桌面端与 Lab 的类型检查，并将独立站点输出到 `apps/desktop/out/bart-lab/`。

启动 Lab 后，可运行 `pnpm --dir apps/desktop exec node tests/bart-reasoning-arc.browser.mjs`，用真实 Chromium 验证不同语言、长短文本及窗口宽度下的新文字可见性和角色尺寸。自定义端口通过 `BART_LAB_URL` 指定。

## Case 01 · 状态

- 最终答复：静态未读红点，hover 或键盘聚焦不展开气泡、不标记已读。点击进入对应答复；Lab 只记录定位事件，生产会话打开后清除未读。

- 常驻：待机、思考、工具调用、长工具名、工作、完成与失败。思考与工具调用由本地 fixture（`residentActivityFor`）提供 Harness 表现投影，预览生产的角色解析与共享渲染模块；常驻表情不再由 execution 是否运行推断。
- 输入：空白、预填内容、单行／三行／五行／六行草稿、带附件与禁用。胶囊随草稿逐行长高并在五行封顶，Dock 底边不动、Bart 被顶得更高；多行与附件 variant 提供可直接比对的静态形态，也可以直接打字看它长。Thread 续写 variant 挂载同一个 Dock 的续写入口，用同一枚胶囊替换草稿输入框。进出的过渡是生产那一套：胶囊从 Dock 底边弹出来并越过自己的高度再回落，Bart 被同一个回弹带上带下；退出是同一段往回走但不带弹。
- Question：单选、多选、自由输入与连续提问，支持提交和取消。
- Permission：文件修改与运行命令，支持本次允许、始终允许和拒绝。
- 在状态之间切换、重放当前场景、调整预览比例、显示参考线，并查看交互结果。
- 思考可切换中文、英文、混合与短文本。弧线保留最新文本在右上方，按实际字宽裁切并渐隐旧内容；56 个 Unicode 码点是数据上限，不再用固定 34 字决定可见长度，字号与角色尺寸保持一致。

### 展示节奏

「展示节奏」使用生产 Dock 的调度模块，提供快速交替、连续思考、连续工具、快速完成和输入接管后恢复五种输入序列。舞台左上角显示真实输入，Bart 展示经过节奏处理的最新片段。

- 最短展示时间：默认 800ms，可调 0–2000ms；0ms 用于比较即时切换。
- 思考文字刷新：默认 150ms，可调 0–500ms；同类文字更新不重播角色入场。
- 事件输入间隔：默认 80ms，可调 20–1000ms，用于模拟不同 Harness 的输出速度。

调整即时生效，仅影响 Lab；「恢复默认参数」重置三个控件，「重放」从头运行当前输入序列。生产先使用 800/150ms，不新增设置项。终态立即打断展示等待；输入、专属动画、飞行或隐藏窗口结束后直接跟上最新活动。

运行 `BART_LAB_URL=http://127.0.0.1:4177/ pnpm --dir apps/desktop exec node tests/bart-cadence.browser.mjs` 可在真实 Chromium 中检查可调节奏、连续装饰的稳定性、角色尺寸、减少动态效果和最终答复交接；证据保存在 `apps/desktop/output/playwright/bart-cadence/`。

运行 `BART_LAB_URL=http://127.0.0.1:4177/ pnpm --dir apps/desktop exec node tests/bart-input.browser.mjs` 可检查输入形态：角色始终保持常驻布局、胶囊逐行长高并在五行封顶、Dock 底边固定、附件在胶囊内部、Dock 变窄时同一草稿重新折行、Thread 续写胶囊与草稿胶囊位置一致、Esc 与点击外部收起且草稿保留；证据保存在 `apps/desktop/output/playwright/bart-input/`。

## Case 02 · 卡片生成

打开 `/generation.html`，或点击首页右上角「卡片生成」。端口被其他 Lab 占用时，可运行
`pnpm --dir apps/desktop exec vite --config labs/bart/vite.config.ts --port 4187`。

- 直接运行生产 `BartThreadGenerations`。准备真实卡片的字体、换行、行框和纹理，一次提交飞行、形变、显露、已知卡片接力及回程。
- 专用 Worker 拥有绘制和完整时钟；主线程只准备资源并交接真实页面。生成期间新内容到达会结束旧演出并显示最新 DOM。
- 支持重新生成和注入 5 秒主线程阻塞。暂停、任意 seek 和通用对外 Motion API 不属于这一阶段。
- `/generation.html?regression` 提供 Codex、Claude、Report 连续生成、长文本、Claude 扩展、新消息、基础取消与 75%/100%/140% 缩放；均为虚构数据，无模型请求。
- `tests/bart-generation.browser.mjs` 检查这些布局和最新 DOM 交接；完整阻塞隔离使用下面的 Electron 验收，浏览器状态轮询不作为阻塞期间的呈现证据。

## 执行隔离验收

运行 `pnpm --dir apps/desktop test:bart-isolation`，串行构建并启动真实 Electron 窗口，覆盖角色/回复/滚动/遮挡、生成接力、跨页、穿眼镜头和设置页组合动作。每个主场景分别注入 2 秒和 5 秒同步阻塞，Main 采集实际内容帧、Renderer 负对照及 Chromium trace。不要与构建或其他 CPU 密集测试并行运行。

测试入口为 `/isolation.html`；`?production`、`?cross-page`、`?camera`、`?settings` 挂载对应生产组件。窗口使用 `loadFile`，可用 `BART_ISOLATION_ENTRY` 指向 ASAR 内同一入口。测量边界和预算见[执行隔离实测记录](../../docs/bart-motion-worker-evidence.md)。

## 与产品保持同步

`src/preview.tsx` 直接挂载当前 `BartDock`（内部使用 `BartLogo`）及其 CSS，并复用 `InteractionQuestionSpec` 和 `ThreadInteractionResponseRequest` 契约。Lab 不复制 SVG 轮廓、弹簧算法、眼睛映射或问答表单。

预览在同源 iframe 内运行，隔离产品样式、布局测量及状态。Lab 仅固定 Dock 的舞台位置、关闭拖拽，并补齐基础样式变量；组件在普通状态切换时保持挂载，以观察真实形态过渡。显式“重放”才重建预览场景。

`src/scenarios.ts` 提供本地场景数据。所有提交都由 Lab 的回调处理，只记录交互结果；不安装 Electron IPC bridge，不调用模型、不写项目文件，也不执行示例命令。附件由 Lab 提供固定的 `BartDraftAttachment` 并支持移除，导入流程本身（选文件）与历史入口只记录点击事件，本 Case 不展开。

Lab 的 TypeScript 源码纳入桌面端 `tsconfig.web.json`。新增状态时更新场景数据及控件，保持预览使用产品实现。
