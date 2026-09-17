# 工作项

Spec 使用当前仓库的 GitHub Issues（`xinyuan0801/OpenAgent`），通过 `gh` 读写。

- 读取 issue 时包含正文、评论和 labels；发布时使用 `--body-file` 保留 Markdown。
- `ready-for-agent` 表示需求明确、可由 agent 实现。发布 spec 时使用此 label；不存在时先创建。
- PR 不作为需求入口。
