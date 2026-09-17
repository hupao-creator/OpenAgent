# 状态持久化边界

当前应用状态只读取 `openagent-state-v6/state.sqlite`（SQLite `user_version=6`）。首次建库在 schema COMMIT 前退出留下的空 `user_version=0` 数据库视为尚无保存状态，只读加载不修改它，后续写入正常初始化；版本 0 但含任何 schema 对象或其他不支持版本仍拒绝读取和采用。不读取、迁移、覆盖、删除或 fallback 到 v5。worktree、schedule、evaluation、attachment ownership、telemetry 等独立仓库保持各自的 owner 和命名空间。

`ThreadStateStore` 拥有内存权威状态、revision guard、命令 scope 和流式合并计时。`SqliteStatePersistence` 是唯一物理存储 owner。它在 Main 内维护实体版本和发布队列，管理两个内容准备 worker 与一个数据库 worker；worker 不拥有 Thread 或应用生命周期，不导入 Harness，也不向 Renderer 或 Report HTML 暴露能力。worker 是构建时导入的静态源码，随 Main bundle 打包，在私有 Node worker 中执行；没有运行时脚本路径、外部 worker 下载或原生 addon。

数据库 `records` 表按实体 key 保存 UTF-8 JSON BLOB：每个 Thread 一条；每个 Report 一条 metadata，加独立 HTML BLOB 字段；settings 与 UI/tag pool 各一条。`entity_order` 按 kind、position 和 id 保存实体顺序。Thread 的 opaque `sessionState`、插件纯投影 `observation` 与 revision 在同一条记录中保存；SQL 不解释插件私有字段、不按私有字段建表或查询。只准备和更新命令影响的实体；未变 Report 的 metadata/HTML 即使经过 reducer 克隆，也按字段比较复用。

50 MiB 限制独立适用于 Thread JSON、Report metadata、Report HTML、settings、UI。流式内存提交在发布前验证其实体上限，后台准备再次检查编码长度；load 在物化数据库 BLOB 之前检查每条长度。Report 公共上限仍是 1,000,000 Unicode 字符。没有全应用共享内容预算。旧 manifest 的 8 MiB 索引限制随该文件格式删除，实体顺序不新增全局内容预算。

命令按实际不变量取得 scope：普通 Thread 更新只锁该 Thread；reports、settings、UI 有独立 scope；Report 归档同时锁 reports 和全部关联 Thread，在锁内比较公开 latest Execution ID，仅将匹配的 Agent 与 Report 一起提交；fork 同时锁 source、target、catalog 和 UI；Bart reset 同时锁旧新 Bart、catalog、UI 和 settings。内容准备在短内存状态队列与数据库 writer 队列之外，两个 worker 有界执行编码，通过转移独占字节缓冲区送入数据库。长时间 Report 准备不会阻止无关 Thread 的 observation 提交、发布及 flush。持久化成功后，在 scope 仍锁定时对最新 state 重放 reducer，保留其他 scope 同期变化。

每次接受的跨实体变更使用一个 `BEGIN IMMEDIATE` / `COMMIT` SQL 事务，WAL、`synchronous=FULL`、2 秒 busy timeout、1000 页自动 checkpoint。新库在启用 WAL 前请求 8 KiB 页面，以减少大 BLOB 的 pager/WAL 开销；现有数据库（包括中断初始化留下的 WAL 文件）沿用其页面大小，不执行格式重写。普通语句错误先 rollback，再向命令返回失败；内存不发布失败的 durable 命令。COMMIT 后才确认持久化。若准备或数据库 worker 异常退出，当前 owner 标记不可继续写入，拒绝后续提交，必须关闭并重新打开；准备失败不会进入事务，但不能继续轮转使用已失效的槽位；数据库 worker 可能已提交，不能假定失败等于 rollback 后继续覆盖磁盘。重开由 SQLite 恢复旧版或完整新版。性能回调失败不能把已成功提交误报成失败。

同一 scope 的 Main 版本检查在最终发布队列中进行，阻止较慢旧内容替换新版。A → 慢 B → 新 A 也必须发布新 A 的版本屏障，不能因为 A 已在磁盘就跳过。全量 save 在全局 command barrier 下提交所有变化，fork/reset 所需实体一起提交。

流式状态继续使用原 debounce/max-wait 合并；completed、failed、interrupted 终态等待持久化后才完成命令。`flushThread(id)` 在该 Thread 的 scope 下捕获权威版本，为 native admission 提供准确屏障。`save`、`flush`、`drain` 是全局 barrier。SQLite 只有一个 writer：已经开始的 SQL 事务不可抢占，后续 durable admission 会等待它；内存 observation 不等待数据库。这个短事务排队成本与内容准备延迟分别测量，不能把长期准备塞进 writer 队列或放宽原跨 Thread 顺序测试。

load 使用独立短生命周期只读 worker/连接，从一个 read transaction 中读取一致状态，关闭后才返回；不会开启新的数据库或回收旧文件。应用后续写入使用自己的 writable worker。应用退出先停止并 drain 所有 mutation producer，再 `ThreadStateStore.close()`：等待已接纳命令，持久化当前脏状态（瞬时失败允许一次重试），drain、关闭 SQLite 连接并等待所有 worker 退出。close 幂等，调用之后拒绝新的 commit/save。没有独立后台数据库 owner，也没有遗留的 manifest/staging/孤儿对象恢复协议。其他仓库使用的公共原子文件工具继续保留。

实测数据与接受门槛见 [SQLite 结果](SQLITE_RESULTS.md)；旧路径的可重跑选择基线见 [基线](SQLITE_BASELINE.md)。macOS arm64 的真实 Electron 与完整应用打包已验证；Windows/Linux 等目标保留，但本机结果不代表这些平台已执行原生验收。
