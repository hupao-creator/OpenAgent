# Codex creation permissions

Creation options are `model?`, `effort?`, `serviceTier?` and `permissionMode?`.
`settings.describe` and `normalizeCodexThreadSettingsRequest` describe and enforce
that boundary. Empty options inherit application defaults. When neither the
creation request nor application defaults configure native permission fields,
the effective preset is `approve-for-me` (`CODEX_DEFAULT_PERMISSION_MODE`).
Explicit native fields always win over that preset. Internal Thread settings,
application defaults and existing Thread settings updates retain native fields.
Core composes the schema and shallow-merges opaque values; the Harness alone
resolves presets and model-associated defaults.

| Mode | Sandbox | Approval policy | Native reviewer |
| --- | --- | --- | --- |
| ask-for-approval | workspace-write | on-request | user |
| approve-for-me | workspace-write | on-request | auto_review |
| full-access | danger-full-access | never | user |

An explicit mode replaces the complete sandbox/approval/reviewer group, including
an inherited custom sandbox policy. The resolved reviewer is persisted and forwarded
on native thread/start, thread/resume, thread/fork and every turn/start. Simple
workspace-write presets also reset native workspace-write configuration before
admission; managed-worktree write roots still come only from the existing Core grant.
Native thread admission must acknowledge the requested reviewer, approval policy
and sandbox type before the first task turn is sent.

## Runtime capability boundary

The integration baseline was checked on 2026-09-09 with Codex CLI 0.153.4, using
`codex app-server generate-json-schema --experimental --out <local-directory>`.
Its four lifecycle request schemas declare `approvalsReviewer`, with `user` and
`auto_review` values. Thread start/resume/fork responses report the effective
reviewer, approval policy and sandbox. Native automatic review owns its own
reviewer lifecycle; OpenAgent does not implement a second approval agent.

Automatic review requires an initialized runtime version at least 0.153.4, a
recognized `config/read.config.approvals_reviewer`, and a successful
`configRequirements/read` whose `allowedApprovalsReviewers` does not exclude
`auto_review`. Older or unidentifiable runtimes are conservatively unsupported.
Creation validates the actual target executable/workspace via the catalog source;
every native turn rechecks support, covering process reconstruction or changed
runtime constraints. Failed probes, denied requirements and missing/mismatched
native acknowledgements fail explicitly without falling back to user approval,
`untrusted`, `never` or full access. Native execution/reviewer failures remain
failures; the Harness does not retry them with another permission mode.

The native reviewer may still leave interactions requiring user input. These use
the existing Harness interaction lifecycle; OpenAgent does not blanket-approve them.

Official semantics: [Sandbox defaults](https://learn.chatgpt.com/docs/sandboxing#configure-defaults).
Regression evidence: `codex-settings-resolution.test.ts` under `apps/desktop/tests`,
and `codex-permission-runtime.test.ts` with `codex-main-regressions.test.ts` under
`packages/harness-codex/tests`. The PR retains actual CLI smoke and complete delivery evidence.
