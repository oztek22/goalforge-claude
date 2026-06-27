# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/oztek22/goalforge-claude/releases/tag/v1.0.0
