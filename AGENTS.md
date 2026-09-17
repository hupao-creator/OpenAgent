# 目标

除非用户明确要求只交付产物而不合并，你的目标始终是把代码合并到 main。
按照流程，过程中尽可能少打扰用户。

# 项目状态

本项目尚未发布，无需保持向后兼容或处理 legacy 数据，可直接进行 breaking change。

# 开发流程

`/grilling` → `/to-spec` → `/implement`。

# PR 审查

使用 `python3 scripts/pr-gate.py` 发起审查和合并，不绕过门禁。
读取并处理审查意见，自行推进 review → fix → review，直至可合并。
命令与异常处理见 [PR 门禁](docs/agents/pr-gate.md)。
