# Lint

用 [oxlint](https://github.com/oxc-project/oxc) 1.82.0 覆盖整个仓库。配置是根目录的
`.oxlintrc.json`，保持最小；规则集用 oxlint 默认集（96 条，来自 unicorn、typescript、oxc
三个插件），不自己挑规则。

```sh
pnpm lint          # 门禁实际跑的
pnpm exec oxlint --fix   # 本地想自动修一批时
```

`pnpm lint` 展开为 `oxlint --deny-warnings --report-unused-disable-directives`，零告警。

## 门槛为什么设在 warning

默认集在这份代码库上是 0 error、若干 warning。只对 error 失败等于什么都不检查，所以
`--deny-warnings` 把 warning 也当失败。相应地**不要在 `.oxlintrc.json` 里按 category 升级
severity**：那样只能覆盖你枚举过的 category，默认集里其他 warning 会漏过去。

`--report-unused-disable-directives` 让失效的豁免自己失败。改代码后某条 `oxlint-disable`
不再命中，会立刻暴露，避免豁免腐烂。

## 提交前

husky 的 pre-commit 钩子跑 `pnpm lint`，`pnpm install` 时由根 `prepare` 装好。
它**不带** `--fix`：提交中途改写工作区会污染已经暂存的内容。

CI 的 `verify` workflow 在类型检查和回归测试之间跑同一个 `pnpm lint`，所以门禁与本地一致。
CI 安装依赖时带 `HUSKY=0`：husky 9 没有自己的 CI 检测，cache-miss 安装时 `prepare` 会把
`core.hooksPath` 写进 checkout 的 git config，而这个 checkout 是一次性的。

## 怎么豁免

优先级从高到低：

1. **改代码**。绝大多数告警值得直接修。
2. **规则级关闭**（`.oxlintrc.json`）。只用于"规则和本仓库的固定写法系统性冲突"的场合，
   当前有两条：`unicorn/no-useless-spread`（迭代中自注销的监听器集合用展开取快照是刻意的）
   和 `eslint/no-control-regex`（控制字符区间本身就是匹配目标，不是误输入）。
3. **行内豁免**，必须写理由：

   ```ts
   // 这个用例测的就是稀疏数组，Array.from({ length: 1 }) 会得到 [undefined] 而不是空位。
   // oxlint-disable-next-line unicorn/no-new-array
   const sparse = new Array(1)
   ```

   **理由写在指令上面，指令紧贴被豁免的那一行。** `disable-next-line` 只看下一行，
   中间隔一行注释的话它作用在注释上：被豁免的代码照常告警，指令本身还被
   `--report-unused-disable-directives` 判为 unused，两边一起失败。

   整个文件都要豁免时用文件头 `/* oxlint-disable <rule> */`。理由写"为什么这里是对的"，
   不写"这条规则不好"。

新增规则级关闭要当成设计决定，别当清理手段。

## 已知边界

**没跑过 `pnpm install` 的 worktree 会静默跳过 lint。** git 对缺失的钩子是静默忽略
（`ENOENT` 直接返回 NULL，只有权限不足才提示），没有选项能让它硬失败。所以新建 worktree
后先装依赖；CI 验证不受影响，它用脚本里显式的 lint 步骤。

**钩子检查的是工作区，不是 Git 索引。** `oxlint` 从磁盘读文件，没有 stdin 模式，所以
部分暂存（`git add -p`、暂存后又改了同一文件但没重新暂存）时，钩子看到的是修正后的工作区、
通过，而提交进去的是索引里的旧内容。这是本地快信号的边界，不是门禁的漏洞：真正把关的是
CI 验证，它在 PR head 的干净 checkout 上跑同一条 `pnpm lint`，索引里那份违例在那里
必然失败、合不进 main。要消掉这个差异就得让钩子先 `git stash` 再 lint，代价是中断提交会
把工作区留在 stash 里，而本仓的 stash 栈在多 worktree / 多 agent 会话间是共享的——不值当。
