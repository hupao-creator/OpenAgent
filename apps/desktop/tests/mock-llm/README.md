# Local LLM acceptance driver

## Scope

Replace the previous paid DeepSeek headless test driver completely. Preserve
real Bart, Core tools, Harness Plugins, CLI subprocesses, permissions, native
sessions, filesystem effects and public observations. Mock only the external
LLM HTTP interface. No real provider smoke suite, key, dotenv or replay recording
is required. Installed CLIs and project dependencies are prerequisites.

The agreed test seams are the LLM HTTP interface and the existing public
native/Bart acceptance surfaces. The mock must never read product state or
expected receipts to manufacture a passing answer.

## Open-source evaluation (2026-09-13)

| Project | Relevant capabilities | Decision |
| --- | --- | --- |
| [llm-mock-server](https://github.com/theblixguy/llm-mock-server) | Node library, three protocols, SSE, tool calls, dynamic request predicates, history | Use pinned `1.1.0` as a development dependency; fits the existing Node runners |
| [kagent-dev/mockllm](https://github.com/kagent-dev/mockllm) | Go HTTP server, three protocols, exact/contains/header matching, JSON fixtures | Viable; an additional runtime/build is unnecessary here |
| [larsakerlund/llmock](https://github.com/larsakerlund/llmock) | Rust HTTP emulator, multiple providers, configurable streaming and fault injection | Viable; the Node interface keeps fixture assertions and worker lifecycle together |

`llm-mock-server` handles HTTP schemas and response serialization. Our request
projection preserves every tool result (including multiple Anthropic result
blocks) and all system/developer instructions. A small pnpm patch stops its SSE
writer when the client disconnects, serves the Claude API connection probe,
and exposes rejected HTTP requests to the evidence recorder; otherwise a cancelled long answer leaves
timers alive. A subprocess regression proves prompt exit after cancellation.

## Interface and ownership

`createAcceptanceLlm({ artifactPath })` owns one loopback server. `expect(match,
reply, streamingOptions)` registers an explicit fixture. `assertHealthy(since)` checks requests after an optional case checkpoint;
calling it without a checkpoint checks the entire run. Rejected HTTP requests,
unmatched requests and failed fixture assertions all fail health. `close()` drains the server,
persists evidence and checks the entire run again, including requests that finished during
shutdown. All replies pass through the real wire serializers.

- `ordinary.mjs`: reads receipt values from instructions/context and the first
  completion receipt from transmitted native history. Checks schema updates.
- `bart.mjs`: reads the explicit JSON directives, returns Core tool calls, and
  requires their native tool results before continuing. Handles terminal events.
- `target.mjs`: drives real native shell/read/question tools, waits for foreground
  command completion and handles native background notifications. Native dialects
  belong to each Harness's test adapter.
- `metadata.mjs`: handles the product's separate structured metadata requests.
- `streaming.mjs`: paces long answers for real cancellation/deletion evidence.

Fixtures may choose the model's next decision, but they cannot execute tools,
modify native state or invent missing HTTP inputs. New scenarios must add an
explicit fixture and retain an independent assertion at the public acceptance
surface. Successful scripted answers do not measure LLM instruction following.

The final worker check runs after native cleanup and server shutdown, so late
metadata or notification failures cannot escape the report. Each resource is
closed independently even when another cleanup fails. Permission journeys use
the existing bounded approval chain because a read outside the working directory
can require another native permission. Independent file and interaction checks
remain mandatory.
