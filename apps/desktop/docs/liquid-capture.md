# Overview liquid glass 捕获与提交

`@liquid-dom/core@0.1.1` 的 pnpm patch 修复两条时序：

- 布局同步发生在浏览器 paint 前，此时 DOM 的 cached paint record 可能缺失或对应旧尺寸。Renderer 只在原生 `paint` 回调内捕获 DOM；任一待捕获层未完成时，不用不完整纹理覆盖上一张完整画面。
- 原库的 `paint` 只更新纹理，不提交画面。WAAPI 自动取景没有 React 逐帧更新，因此 demand 模式会停在过渡中间。捕获完成后直接合成、提交，不依赖悬停跟帧的 220ms 窗口。

窗口增大时，等待新捕获期间将上一张完整画面缩放至新画布，避免原来的局部复制在右侧、底部留下黑边。这里不设置“失败若干帧后放行”的计数器；失败仍然不能提交不完整画面。失败的 paint 会主动请求下一次 paint，成功后停止，销毁时取消，恢复不依赖新的鼠标或 DOM 变化。

原生 paint 中的异常保存在 Renderer，并通过画布事件唤醒受保护的 React 帧循环；既有 onError 会把 Overview 降级为普通 DOM。

相机手势只触发画面失效。舞台尺寸和浮条盒子变化仍通过各自的尺寸观察器更新布局。

## 原生回归

在具备图形会话与 WebGPU 的机器上执行：

```sh
pnpm --dir apps/desktop test:liquid-runtime
```

该命令开启独立 Electron 窗口与临时数据目录，使用仓库的 Electron 和真实 GPU。覆盖 360ms 原生动画的连续提交、15 次自主捕获重试失败、画布扩容、解除故障后无需 DOM 变更即可恢复、异步提交异常接回受保护的 render，以及闲置和销毁后不再提交。控制台错误通道先用 sentinel 验证，避免空日志假通过。采样最终合成画面的空白区域，黑帧和 GPU/控制台错误会令测试失败。日志及失败截图保存在命令输出的临时目录。

这项真机 GPU 回归独立于 GitHub Actions `verify`；CI 的 DOM 测试验证相机失效路径，不把缺少原生 GPU 的环境当成通过。本地原生结果应随 PR 记录。

升级 liquid-dom 时同时检查 ESM/CJS 补丁是否仍需要，并重新运行原生回归。
