# OpenAgent 性能底座

这份文档记录需要在持续功能迭代中保持的性能不变量。目标不是追求某次跑分，而是让高频成本只与“本次真正变化的数据”相关，不随历史记录和功能数量无界放大。

## 热路径

```text
Provider 原生流
  ├─ Provider fact / surface：按 provider 归一化并投影
  ├─ Main state：批量应用状态 mutation，done 立即刷新
  └─ Renderer IPC：接收 state mutation
       └─ React：一次 setState / batch
            └─ 仅 streaming message 重新解析 Markdown
```

必须保持以下约束：

1. 不要让 token delta 直接触发逐事件 IPC 或逐事件 React 更新。
2. `done` 必须立即刷新，且完整 state snapshot 发送前必须先刷新待发送 mutation，避免重复追加。
3. Provider surface 和 state mutation 必须保持结构共享：未变化的会话、消息和 activity 引用不能被批量复制。
4. Sidebar、Composer 和已完成 Message 不应因当前消息的 token 更新而重新渲染；流式 Markdown 使用 deferred value，允许 React 丢弃过时的中间解析。
5. 用户向上浏览历史时，流式更新不读取 `scrollHeight` 或强制拉回底部；显式加载更早消息时可读取一次以保持锚点。
6. 开始任务和删除会话通过小型 state mutation 同步 renderer，不发送完整历史快照。
7. 会话初次只挂载最近 120 条消息；更早历史按 100 条显式加载，DOM 和 Markdown 初始解析不能随完整历史无界增长。

## 持久化

磁盘格式位于 Electron `userData/openagent-state-v2/`：

```text
manifest.json              # 设置、选择状态、会话 id 顺序
conversations/<sha256>.json # 单个会话
```

写入顺序是“变化的会话文件 → manifest → 清理不再引用的文件”，每个文件都通过同目录临时文件原子替换。运行时只读取严格的当前 v2 分片格式；旧文件、非当前 schema 与未知字段会整体拒绝，不做兼容读取或迁移。

新增持久化字段时，优先放入所属会话，避免把高频数据放进 manifest；否则任一 token 更新都会重新写全局文件。若总状态接近 50 MB，下一步应引入按需加载/分页，而不是继续抬高上限。

工具活动详情只是 UI 预览，不是 provider 的权威 transcript；所有入口统一限制为 20,000 字符，命令输出保留尾部，工具参数保留头部。恢复当前 v2 状态时也必须应用同一上限，避免已有的无界 activity detail 让总状态达到 50 MB 后锁死后续保存。

## 验证

```bash
pnpm test:desktop
pnpm perf:bench
pnpm build:desktop
```

Provider adapter 和 Bart thread 的定向测试覆盖上述架构约束；性能验证不使用易受机器负载影响的绝对耗时断言。
