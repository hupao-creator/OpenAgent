# 本地分级验证

OpenAgent 使用本机执行分级验证，原生与开发链路检查使用 Mac。GitHub 负责 PR、评审和提交状态。
仓库不再自动运行收费的 GitHub Actions 工作流，也不需要安装常驻 runner。

## 使用

需要 macOS、Node.js 22.19+、Git 和仓库声明的 pnpm 版本（当前为 10.17.1）。
Electron 原生验证需要可启动桌面应用的 macOS 登录会话。
需要产品检查时安装锁定依赖和 Electron；开发热更新检查还会安装 Playwright Chromium。
纯文档和 PR 门禁改动不安装这些依赖。

```sh
# 提交代码后，验证当前 HEAD；无需先安装项目依赖
pnpm verify

# 验证本地指定提交，不修改当前分支
pnpm verify --ref <commit>

# 获取并验证 PR 的最新 head；需要 gh 已登录且能访问该仓库
pnpm verify --pr 35

# 同时发布 PR 验证摘要和独立的提交状态
pnpm verify --pr 35 --publish

# 仅预览按完整 PR diff 选择的计划
pnpm verify --pr 35 --plan

# 本地指定比较基线，启用分级
pnpm verify --base origin/main

# 强制完整检查
pnpm verify --pr 35 --full
```

入口也可直接使用 `node scripts/verify.mjs`。`--publish` 要求 `--pr`，
使用当前 `gh` 身份，需要该仓库的 PR 评论与 Commit statuses 写权限。
默认只在本地执行，不写 GitHub。脚本不会提交代码、推送分支或合并 PR。

这是执行可信本地代码的开发命令，worktree 仅隔离仓库文件，并不是安全沙箱。
`--pr` 在下载和执行前仅接受当前 GitHub 登录用户创建的同仓库 PR，拒绝 fork
和其他作者的 PR。外部贡献应在不含开发者凭据的临时机器或独立账号中验证。
`HEAD` / `--ref` 同样只适用于已经审阅并信任的本地提交。
验证子进程仅继承构建所需的环境变量白名单，不继承 GitHub token 或其他 Agent
会话配置；GitHub 状态回写由父进程完成。白名单里包含 `HUSKY=0`：一次性 checkout
的安装步骤不应改写共享的 `core.hooksPath`，脚本会在安装前后断言这个值未变。
这不限制可信代码访问本机用户文件。

命令要求发起验证的 checkout 干净，避免把尚未提交的改动误认为已验证。
每次创建全新的 detached worktree，位置为
`~/Developer/.openagent-verification/<时间>-<SHA>-<随机值>/checkout`。
不使用开发中的 worktree 或其构建产物，不迁移现有项目或影响开发窗口。
检查完成或失败后自动移除此次创建的 worktree，日志保留在它的父目录。

## 检查范围

`--pr` 根据 PR merge-base 到 head 的完整差异选择检查；本地通过 `--base` 指定比较基线，
没有基线时全量。混合改动取并集，包源码改动沿工作区反向依赖传播。详见
[分级规则与验收](../../../docs/agents/verification-scope.md)。

`--full` 执行完整检查：

1. 安装锁定依赖，记录 Node、pnpm、TypeScript、操作系统和架构。
2. 从干净 checkout 构建插件并生成注册表，检查生成结果与提交一致。
3. 完整类型检查、lint 和现有回归测试（`pnpm typecheck`、`pnpm lint`、`pnpm test`）。
4. 真实 Chromium 验证插件源码更新到浏览器和 Main bundle、CSS 热更新、源码恢复及开发进程退出。
5. 生产构建（`pnpm build`）。
6. 现有真实 Electron 报告隔离与应用生命周期回归。
7. 检查没有遗留源码变更。

热更新检查从原工作流提取到 `scripts/verify-development.mjs`，仅在隔离 checkout
临时修改 fixture 源码并恢复。没有新增测试用例。
任何检查失败都会停止后续步骤、保留日志并返回非零退出码，不会报告成功。
这条流程验证 PR head，不构造与 base 的临时合并提交；base 发生相关变化时先更新分支再验证。

## 结果与 PR

每次执行保留：

- `summary.md`：受检 SHA、验证脚本 SHA、比较基线、必跑/跳过步骤、工具版本、结果和耗时。
- `result.json`：完整变更路径、影响工作区、选择理由、结构化结果、步骤命令、日志 SHA-256、发布状态及错误。
- `logs/`：每个步骤的完整输出。
- `lifecycle/`：应用生命周期验证的原生进程与退出证据。
- `tmp/`：此轮检查使用的临时文件。

`--publish` 在开始时给受检 SHA 标记 `pending`，完成后发布一条 PR 摘要评论，
再将 `local/desktop-verification` 标记为 `success` 或 `failure`，详情链接指向该评论。
只发布摘要，完整日志保留在执行机器上。发布失败返回非零退出码，详情保存在本地；
排查 GitHub 连接或权限后重新运行同一命令。

执行中即使 PR 有了新提交，结果也只写入最初受检 SHA，评论会提示需要重新验证。
更新后的提交必须重新运行命令；PR base 改变后也必须重跑，门禁会拒绝旧基线证据。
不同于 GitHub Actions 的旧检查，这个状态明确标注
本地来源，不覆盖或伪造以前因额度未能启动的检查。

合并前检查 PR 最新 SHA 和 base 与验证摘要一致、全部必跑步骤通过、代码评审已完成。
如果未来配置合并保护，使用 `local/desktop-verification` 作为检查名称。
历史 Actions 失败仍会显示在旧 PR；不能把“未执行”改写成成功。

这些是由本机开发者报告的验证结果，日志不会自动上传为独立托管证据。
需要复核时，另一台 Mac 可以对同一 SHA 执行相同命令。
保留需要的日志后，可手动删除对应执行目录；清理失败时先查看 `result.json`，
确认该路径确属本次验证的 worktree 再处理。

GitHub 状态回写使用 [Commit Status API](https://docs.github.com/en/rest/commits/statuses)，
不触发 GitHub Actions，也不消耗托管 runner 的执行额度。
