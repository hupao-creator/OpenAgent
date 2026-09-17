# SQLite selection baseline (issue #57)

Measured on macOS arm64, Node 22.22.2, 2026-09-08, production base `5f1ab6823a95094e89f9b30c2cd617407f7b76d4`. These are local observations, not claims about other platforms or a completed SQLite replacement. This is the historical selection baseline from PR #59; production now uses v6 SQLite. To repeat the v5 baseline, run this workload at commit `d3659074f6528bc2cccf42ed5cf309cc7b8fd6b7` in a separate checkout. The same command on current source measures SQLite; see [current results](SQLITE_RESULTS.md).

## Repeatable application workload

Install the locked dependencies and build current registries, then repeat this command with three distinct absolute result paths:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/desktop generate:registry
OPENAGENT_STATE_BENCH=/absolute/local/result.json pnpm --dir apps/desktop exec vitest run tests/state-persistence-benchmark.test.ts
```

The opt-in benchmark uses the real ThreadStateStore public API: 12 Agent Threads containing 19 MiB total Session payload (one 8 MiB Session), 12 stream rounds (all 12 Thread commits issued concurrently in each round, preserving per-Thread revision order), terminal completion, Thread admission flushes and global flush. Concurrently it commits 16 Reports each containing 999,999 emoji Unicode characters, close to the public per-Report limit and exceeding 50 MiB in aggregate. Startup opens a fresh store and checks entity counts and a completed terminal observation. The result records runtime, workload, latency distributions, sampled process RSS and recursive disk bytes. Tests remain skipped during ordinary regression runs. RSS includes the complete test process; samples are 5 ms apart and are not a heap profiler. Startup includes parsing and current-schema validation with a warm filesystem cache. Flush is measured after terminal completion, so its low value is not a general pending-write claim.

| Metric | Run 1 | Run 2 | Run 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Event loop p95 (ms) | 165.54 | 145.62 | 135.27 | 145.62 |
| Event loop p99 (ms) | 1261.44 | 873.99 | 807.93 | 873.99 |
| Event loop max (ms) | 1514.14 | 1534.07 | 1254.10 | 1514.14 |
| Streaming p95 (ms) | 1014.22 | 1147.98 | 1059.59 | 1059.59 |
| Streaming max (ms) | 1035.81 | 1210.40 | 1095.18 | 1095.18 |
| Admission p95 (ms) | 1759.74 | 1038.89 | 855.02 | 1038.89 |
| Terminal p95 (ms) | 66.36 | 64.14 | 64.28 | 64.28 |
| Global flush (ms) | 0.21 | 0.21 | 0.20 | 0.21 |
| Startup (ms) | 996.23 | 1095.36 | 1138.51 | 1095.36 |
| Peak RSS (MiB) | 770.73 | 1185.55 | 1211.59 | 1185.55 |
| Disk (MiB) | 80.04 | 80.04 | 80.04 | 80.04 |

The original serial-within-round experiment is retained as superseded evidence; these final values use the concurrent workload corrected after remote finding R1. No production SQLite numbers were used to set the v5 baseline.

The large initial Report reducer/validation and current synchronous content serialization are included in event-loop and streaming maxima. The test does not hide these costs. This first delivery measures baseline rather than claiming an improvement. The replacement must use the identical workload and satisfy the relative and absolute budgets in the [results table](SQLITE_RESULTS.md#initial-accepted-comparison). Record live SQLite/WAL peak as well as checkpointed disk in the dependent delivery.

## Driver and execution-location probe

```sh
PROBE_OUTPUT_DIRECTORY=/absolute/local/evidence node apps/desktop/scripts/sqlite-driver-probe.cjs
PROBE_OUTPUT_DIRECTORY=/absolute/local/evidence apps/desktop/node_modules/.bin/electron apps/desktop/scripts/sqlite-driver-probe.cjs
```

The standalone CommonJS probe creates isolated databases under the supplied local evidence directory and retains them. It compares Main and worker execution sequentially, eight transactions each: an approximately 8 MiB Session JSON plus 1,000,000 emoji HTML characters, WAL, synchronous FULL. It closes and reopens both databases and asserts the exact original JSON and final HTML. Loop delay uses a 2 ms sampling timer; results include transaction and serialization durations, end-to-end latency, disk and RSS. This is a small driver experiment; sequential modes can differ in cache and GC, and it does not replace the whole-store benchmark.

Built-in SQLite versions observed: Node 22.22.2 / SQLite 3.51.3; Electron 43.3.0 / Node 24.18.1 / SQLite 3.53.1. Node 22 emits an experimental API warning. No native addon was installed or rebuilt.

Observed node-probe:

| Mode | Maximum loop delay (ms) | Maximum transaction (ms) | Maximum end-to-end (ms) |
| --- | ---: | ---: | ---: |
| main | 90.37 | 59.72 | 89.84 |
| worker | 2.83 | 55.51 | 90.40 |

Observed electron-probe:

| Mode | Maximum loop delay (ms) | Maximum transaction (ms) | Maximum end-to-end (ms) |
| --- | ---: | ---: | ---: |
| main | 186.99 | 78.89 | 82.06 |
| worker | 4.54 | 57.95 | 68.31 |

A separate electron-vite `?modulePath` experiment emitted a dedicated worker asset. electron-builder 26.15.3 created a real macOS arm64 `.app` whose Main launched that asset inside `app.asar`; the worker opened/wrote/closed/reopened SQLite and recovered its exact value. No `asarUnpack` or native rebuild was required. That selection experiment is evidence of feasibility, not validation of the forthcoming production bundle. Its command transcript and results are retained with PR evidence. The implementation delivery must repeat the lifecycle against its actual built and packaged application.

`better-sqlite3` would add a native addon and Electron ABI/rebuild packaging work; no need for that dependency was demonstrated by the built-in probe. A Main synchronous driver increases event-loop delay. A worker still has one SQLite writer and does not remove admission queueing. A bounded preparation pool outside the writer is selected to prevent long content preparation from owning the publication queue.
