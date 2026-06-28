# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.2.1] — 2026-06-28

### Fixed

- **`--cost N` flag now respected** — `CostOptimizer` was always constructed with the hardcoded `DEFAULT_BUDGET` ($10), ignoring the value passed via `--cost`. It now merges `config.maxCostUsd` into the budget so the spend cap and `remainingUsd` display correctly.
- **Rate limit in planner propagates correctly** — a `RateLimitError` thrown during the Plan phase was swallowed by the catch block and logged as a generic planner failure. It is now re-thrown so the outer loop's sleep-and-retry handler can pause until the reset window expires.

---

## [1.2.0] — 2026-06-28

### Added

- **Per-iteration memory cleanup** — a new `cleanupPhase()` runs at the end of every iteration (after `updateMemoryPhase`). It calls `MemoryStore.cleanupMemory()`, which removes critique files for tasks already in `completedTaskIds` (they won't be re-reviewed and were inflating `criticalIssueCount`) and evicts the oldest cache entries once the cache exceeds 200 files, preventing unbounded disk growth.
- **Post-success full cleanup** (`engine/src/components/cleanup.ts`) — a new module that wipes all run-specific memory files after a successful loop exit (`no-critical-issues`, `all-tasks-complete`, `coverage-met`, `tests-passing`). Clears `tasks/`, `critiques/`, `cache/`, `files/`, and `state/project.json`. Preserves `decisions/` (ADRs carry forward to future runs) and `OUTBOX.md` (cross-run learning log). Called from `index.ts` after `appendToChangelog()` so changelog generation still has access to task files. `isSuccessExit()` helper exported for external callers.

### Changed

- **Loop comment updated** — the iteration comment in `run()` now reads "Update memory / cleanup / check exit conditions" to reflect the added cleanup step.

---

## [1.1.1] — 2026-06-28

### Fixed

- Auto-changelog now writes a single short bullet to `CHANGELOG.md` instead of dumping every task objective. Full task details (objectives, outputs, files written) go to a timestamped file under `logs/`.

---

## [1.1.0] — 2026-06-28

### Added

- **Prompt logging in TUI** — every Claude call now prints a `⟡ Claude prompt [taskId]` header to the terminal before the subprocess spawns. Shows the first 120 chars of the system prompt and first 400 chars of the user prompt (newlines rendered as `↵`), routed through `StatusBar.wrapLog` so the sticky footer stays anchored at the bottom. Previously required `GOALFORGE_DEBUG=true`; now always visible.
- **Failed-task repair loop** — when a task fails execution and has fewer than 2 prior retries, GoalForge now calls Claude to diagnose the root cause and produce a revised objective. The repair runs in parallel for all failed tasks in the batch. If Claude provides a revised objective it replaces the original; otherwise the root cause is appended to the existing objective so the next attempt has explicit context. The task is then re-queued as PENDING for the next iteration. Tasks that exhaust two retries are permanently abandoned.
- **Auto-resume on no-goal invocation** — when `goalforge` is run with no arguments, it now checks `.goalforge/memory/tasks/` for any PENDING, RUNNING, or BLOCKED tasks before studying the codebase for a new goal. If unfinished work is found, it resumes the previous run (same project ID, same task queue) and prints the same resume banner as `goalforge resume`. Goal discovery only runs when the previous run completed cleanly or no state exists.
- **Real-time Claude streaming** — switched `callClaude` from `--output-format json` (silent until done) to `--output-format stream-json` (NDJSON events). The first 500 chars of Claude's response stream to the terminal as it generates, so users see progress immediately instead of a frozen screen.
- **Status bar `activity` field** — the sticky footer now shows a short label while a Claude call is in flight (e.g. `Claude implementing: Create REST API routes…`), cleared automatically when the call returns.
- **Status bar heartbeat** — a 5-second `setInterval` in `callClaude` keeps the elapsed-time display ticking during long Claude calls so the timer no longer appears frozen.
- **Prominent task announce/complete lines** — iteration header is now `━━━ Iteration N/M ━━━`; task start prints `▶ Starting: "<objective>"`; task complete prints `✓ Task complete (N done)`.
- **Planned task list printed** — after the planner returns, each task is printed as a numbered list with effort level before execution begins.
- **Review verdict line** — reviewer now prints `Review ✓ passed — score 85/100` (or `✗ failed` with the top critiques inline) instead of a buried JSON meta object.
- **File write summary** — executor prints `Done — wrote N file(s): <paths>` after applying Claude's changes.
- **`--debug` / `-D` flag** — enables verbose Claude CLI logging: logs prompt character count before each call, and exit code and response char count after. Also sets `LOG_LEVEL=DEBUG` for all components. Settable via `GOALFORGE_DEBUG=true` env var without the flag.
- **`ClaudeCLI` log component** — added `⟡ ClaudeCLI` (cyan) to the per-component colour/icon theme so Claude subprocess log lines are visually distinct from planner/executor/reviewer output.
- **Elapsed time in status bar** — the footer now shows a running `00m 00s` / `1h 23m` timer alongside phase, iteration, cost, and task counts. Timer starts when `init()` is called and redraws on every `update()`.
- **`goalforge contribute`** — run from any directory to fork `oztek22/goalforge-claude`, ask what improvement to make, run the autonomous loop on the GoalForge source itself, commit the result, and open a pull request — all in one command. Requires `gh` CLI authenticated with `gh auth login`.
- **`goalforge` (no args) — auto-discover mode** — when run with no goal, GoalForge reads the file tree and key source files of the current project, asks Claude what the most impactful improvement would be, then runs that as the goal automatically.
- **Auto-changelog** — after every successful run, GoalForge appends a dated block of completed task objectives (categorised as Added / Changed / Fixed by objective prefix) to `CHANGELOG.md` under `## [Unreleased]`. Creates the file if absent.
- **Interactive pause/resume** — press Ctrl+C once mid-run to pause after the current AI call finishes; choose to continue, inject feedback, redo from scratch, or quit. Press Ctrl+C again to force-quit immediately (`process.exit(130)`).
- **`goalforge resume` subcommand** — after a double Ctrl+C force-quit, run `goalforge resume` in the same directory to pick up exactly where the loop left off. Reads saved state from `.goalforge/memory/state/project.json` and passes the same `projectId` to `LoopController`, which restores tasks, spend, and iteration count. `TaskQueue.hydrate()` automatically resets any in-flight `RUNNING` tasks to `PENDING`.
- **Sticky status bar** — a persistent 2-line footer always anchored to the bottom of the terminal showing current phase, iteration count, tasks done/failed, and cumulative cost. Erases cleanly before any log line (`wrapLog` pattern) and before interactive prompts (`suspend/resume`). Silent in non-TTY environments.
- **Per-component log colours and icons** — each component has a unique icon and ANSI colour: `⬡ GoalForge` white, `◈ LoopController` cyan, `◆ Planner` magenta, `▶ Executor` green, `● Reviewer` yellow, `✓ TestRunner` blue, `○ MemoryStore` dim, `≡ TaskQueue` dim. Makes it instantly clear which part of the loop produced each log line.
- **Finish prompt** — after any normal loop exit the tool asks "Was this what you wanted?" — press Enter to accept and exit, type feedback to redo from scratch with that direction, or `q` to quit.
- **Auto-gitignore** — `.goalforge` is automatically added to `.gitignore` on first run; the file is created if it doesn't exist.

### Changed

- **Parallel task execution** — `executePhase` now collects up to 3 independent eligible tasks (those whose dependencies are already `COMPLETE`) and runs them with `Promise.allSettled`. Each task spawns its own Claude subprocess so they execute simultaneously at the OS level. Tasks with unresolved dependencies remain in the queue and are not included in the batch.
- **Parallel reviews** — `reviewPhase` now runs all pending reviews concurrently via `Promise.allSettled` instead of a sequential `for` loop. Each review is an independent Claude call with no shared mutable state.
- **Concurrent test + review** — the main loop now calls `testPhase` and `reviewPhase` with `Promise.all` so the test suite and code reviews proceed simultaneously. Previously they ran back-to-back.
- **Async test runner** — `TestRunner.execTests` was converted from `execSync` (event-loop-blocking) to `promisify(exec)` (non-blocking). This was a prerequisite for test/review parallelism: `execSync` would have held the event loop and prevented review Claude calls from progressing.
- **`execSync` stdio for shell commands** — executor now uses `stdio: 'inherit'` (was `'pipe'`) so commands like `npm install` print their output to the terminal instead of running silently.
- **PWD as workspace** — generated files are now written directly into the current working directory (PWD) instead of a `workspace/` subdirectory. Run `goalforge` from your project root and code lands in place.
- **State directory moved** — persistent state is now stored in `.goalforge/memory/` inside the project root (was `engine/memory/`). The `/build` skill stores state in `.goalforge/build/` (was `workspace/.build/`).
- **`goalforge resume` replaces `--id` flag** — resuming a run is now `goalforge resume` (reads the last saved state automatically) instead of passing `--id <project-id>`.
- **`--workspace` default** — defaults to `./` (current directory) instead of `./workspace`.
- **`/build` skill** — updated to write files into PWD, store state in `.goalforge/build/`, and run tests from PWD rather than from `./workspace`.

### Fixed

- **Streaming result extraction** — `callClaude` now parses the `result` event directly from the NDJSON stream instead of applying a fragile `lastIndexOf('{')` heuristic over the full buffered output.
- **Planner re-fires every iteration** — dependencies returned by the planner as objective strings were stored verbatim but looked up as UUIDs in `TaskQueue.canRun()`, so every dependent task was permanently ineligible. `enqueueBatch` now pre-generates UUIDs for the batch, builds an objective→ID map, and rewrites each task's `dependencies` to resolved IDs before storing. Also deduplicates by objective name so a re-firing planner cannot accumulate duplicate tasks.
- **Planner fires when tasks are stuck** — added a guard in `planPhase` that skips re-planning when tasks exist in the queue but none are eligible (broken dependency chain), preventing runaway plan-cycle accumulation.
- **Cost resets to $0 on restart** — `CostOptimizer.restoreFromState` only restored token counters but not `directCostUsd`, which holds all CLI-reported costs. Since `recordUsage` is never called (only `recordCost`), every process restart silently zeroed the displayed spend. The fix passes `existing.totalCostUsd` as the third argument to `restoreFromState`, which now sets `directCostUsd` directly.
- **Silent $0 cost when CLI omits `total_cost_usd`** — when using a Claude.ai subscription the CLI JSON may not include `total_cost_usd`. Previously this silently defaulted to `0`; it now logs a structured warning via the `ClaudeCLI` logger explaining that subscription billing does not report per-call cost.
- **`claude exited 1` showed raw JSON** — when the Claude CLI exited non-zero, the error message was the full raw stdout blob. It now attempts to parse the stdout as JSON first and extracts the human-readable `result` field (e.g. `Not logged in · Please run /login`) so the error is immediately actionable.
- **`is_error: true` not checked on successful exit** — defensively detects `is_error: true` in the JSON envelope even when the CLI exits 0, and throws a clean error rather than silently returning the error text as a usable result.
- **Auto-discover crashes when Claude call fails** — `discoverGoal` (the no-goal path) propagated Claude errors up to `main()`, crashing the entire run. It now catches the error, logs a warning, and falls back to a generic improvement goal so the loop can still start.
- **Claude CLI timeout on real projects** — the per-call timeout was hardcoded at 180 s (3 minutes), causing `Execution failed: Error: claude CLI timed out after 180000ms` on non-trivial executor tasks such as full-file code generation. The default is now **600 s (10 minutes)**, exposed as a `--timeout <seconds>` CLI flag and `CLAUDE_TIMEOUT_MS` environment variable. The value is threaded through `LoopConfig.claudeTimeoutMs` → `LoopController` → `Planner`, `Executor`, and `Reviewer` so every Claude subprocess honours the same limit.
- **"is not valid JSON" errors** — all Claude response parsers (planner, executor, reviewer, and the CLI envelope) now use a 3-strategy fallback: direct parse → extract from last `{` → extract from first `{`. Eliminates failures caused by prose preambles or markdown fences wrapping the JSON payload.
- **Pause prompt delayed past Ctrl+C** — the pause check now runs before each task inside the execute and review inner loops (`if (this.session?.isPaused()) break`), so the prompt appears quickly instead of waiting until the end of the full iteration.
- **Pause banner showed `idle` phase** — `currentPhase` is now captured before `updateMemoryPhase()` resets it to `idle`, so the banner correctly shows the phase that was active when Ctrl+C was pressed.

---

## [1.0.0] — 2026-06-27

### Added

- **Autonomous 6-phase development loop** — Plan → Execute → Test → Review → Exit Check → Memory Update, repeating until the goal is met or a cap is reached
- **`goalforge` CLI** — global binary installed via `npm install -g goalforge-claude`; accepts a plain-English goal and all config as flags
- **No API key required** — the engine calls Claude via `claude -p --output-format json`, authenticating through the user's Claude.ai subscription (Pro / Teams)
- **Fresh context per phase** — each Planner, Executor, and Reviewer call spawns an isolated subprocess with a clean 200k-token window; long-running projects never hit context limits
- **Planner** (`engine/src/components/planner.ts`) — uses Claude Sonnet to decompose a goal into a prioritised, dependency-aware task list; output is JSON-validated against `PlannerOutput[]`
- **Executor** (`engine/src/components/executor.ts`) — implements one task at a time; writes files under `workspace/` and runs shell commands; skips writes in dry-run mode
- **TestRunner** (`engine/src/components/test-runner.ts`) — auto-detects Jest (by config file or `package.json` dependency) and runs with `--coverage --json`; returns an empty report if no test suite found
- **Reviewer** (`engine/src/components/reviewer.ts`) — uses Claude Haiku to score completed task output 0–100; score < 70 or any critical issue triggers a retry (max 2 per task)
- **CostOptimizer** (`engine/src/components/cost-optimizer.ts`) — tracks cumulative spend from CLI-reported costs; prompt-level SHA-256 response cache backed by `MemoryStore`; warns at 80% of cap
- **MemoryStore** (`engine/src/components/memory-store.ts`) — file-system KV store for tasks, critiques, architecture decisions, generated file metadata, and the response cache
- **Crash recovery** — `RUNNING` tasks are reset to `PENDING` on startup; no task is silently abandoned after a crash or Ctrl+C
- **Retry tracking** — failed tasks are re-queued with an incremented `retryCount`; exhausted retries mark the task `FAILED` and the loop continues
- **Spend cap** — `--cost <N>` flag hard-stops the loop when cumulative CLI-reported spend exceeds the limit
- **Coverage gate** — the loop exits cleanly only when Jest reports ≥ target line coverage (default 95%)
- **Dry-run mode** — `--dry-run` / `-d` skips all Claude calls and file writes; writes placeholder `.txt` files so the full loop can be exercised without cost
- **Project resume** — `--id <project-id>` reuses an existing `MemoryStore`, picking up tasks, decisions, and spend tracking from a prior run
- **`/build` skill** (`.claude/commands/build.md`) — a native Claude Code slash command that runs the same 6-phase loop using Claude's built-in Write/Edit/Bash tools; state persisted in `workspace/.build/` via `BACKLOG.md`, `STATE.md`, and `DECISIONS.md`
- **Full CLI flags** — `--iter`, `--cost`, `--cover`, `--id`, `--workspace`, `--dry-run`, `--version`, `--help` with short forms; all overridable via environment variables
- **Jest test suite** — unit tests for all components with temp-directory isolation; `beforeEach` cleanup prevents cross-test state bleed
- **Developer reference** (`engine/README.md`) — architecture diagram, component API, data flow, memory layout, exit conditions, config table, and extension guide
- **User manual** (`MANUAL.md`) — plain-English setup, usage, cost model, output guide, and troubleshooting for non-engineers

### Technical notes

- TypeScript 5, Node.js 20+
- Zero runtime dependencies — the engine shell is `{}`; all AI calls go through the `claude` subprocess
- `files` field in `package.json` whitelists only `dist/` and `README.md` in the npm tarball (38.8 kB packed)

[1.2.1]: https://github.com/oztek22/goalforge-claude/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/oztek22/goalforge-claude/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/oztek22/goalforge-claude/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/oztek22/goalforge-claude/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/oztek22/goalforge-claude/releases/tag/v1.0.0
