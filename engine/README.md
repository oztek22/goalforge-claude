# GoalForge — Developer Reference

Describe what you want. Claude builds it. No API key needed.

An autonomous AI development loop that decomposes a high-level goal into tasks, executes them via Claude, validates the output, and iterates until the goal is met or a budget/iteration limit is hit.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Component Reference](#component-reference)
3. [Data Flow](#data-flow)
4. [Memory Layout](#memory-layout)
5. [Exit Conditions](#exit-conditions)
6. [Configuration](#configuration)
7. [Running Locally](#running-locally)
8. [Testing](#testing)
9. [Extending the System](#extending-the-system)

---

## Architecture

```
index.ts
  └── LoopController          ← main event loop
        ├── Planner           ← goal → ordered task list (Claude)
        ├── TaskQueue         ← dependency-aware in-memory queue + disk persistence
        ├── Executor          ← task → files + shell commands (Claude)
        ├── TestRunner        ← runs jest/npm test in workspace, parses report
        ├── Reviewer          ← critiques completed task output (Claude)
        ├── CostOptimizer     ← spend budget tracking + prompt-level response cache
        └── MemoryStore       ← file-system KV store for all persistent state
```

Each iteration of the loop runs six phases in order:

```
PLAN → EXECUTE → TEST → REVIEW → COST CHECK → MEMORY UPDATE → (repeat or exit)
```

---

## Component Reference

### `LoopController` (`src/loop-controller.ts`)

The main orchestrator. Owns all component instances and drives the six-phase loop.

**Key methods**

| Method | Description |
|--------|-------------|
| `run()` | Start the loop. Returns a `LoopExitReason` when done. |
| `getState()` | Snapshot of current `ProjectState` (safe to call before `run()`). |

**Loop phases**

| Phase | What it does |
|-------|-------------|
| `planPhase` | Skips re-planning if eligible tasks exist; otherwise calls `Planner`. |
| `executePhase` | Runs up to 3 eligible tasks per iteration. |
| `testPhase` | Calls `TestRunner`, updates coverage + pass/fail on state. |
| `reviewPhase` | Reviews the last 3 completed tasks; requeues if score < 70 and `retryCount < 2`. |
| `costCheckPhase` | Exits loop if total spend exceeds `maxCostUsd`. |
| `updateMemoryPhase` | Persists `ProjectState` to disk and logs memory summary; `checkExitConditions()` is called immediately after by the loop. |

---

### `Planner` (`src/components/planner.ts`)

Calls Claude with a structured prompt and the current project state to produce a prioritised task list and architecture decisions.

**Caching**: the response cache key is a SHA-256 hash of the full prompt (goal + context). In dry-run mode responses are never cached to disk (use the `dryRun` flag for tests).

**Output shape** (`PlannerOutput[]`)

```ts
{
  objective: string;
  priority: number;        // 1 = highest
  dependencies: string[];  // index strings ("0", "1") referencing tasks in the same planner response
  estimatedEffort: 'low' | 'medium' | 'high';
  rationale?: string;
}
```

---

### `TaskQueue` (`src/components/task-queue.ts`)

In-memory map of `Task` objects backed by `MemoryStore`. Dependency resolution happens at eligibility check time — a task is eligible only if all its dependency IDs have `status === 'COMPLETE'`.

**Key methods**

| Method | Description |
|--------|-------------|
| `nextEligible()` | Highest-priority PENDING task whose deps are all COMPLETE, or `null`. |
| `enqueueBatch(plans)` | Bulk enqueue from planner output. |
| `start(id)` | PENDING → RUNNING. Throws if deps unresolved. |
| `complete(id)` | RUNNING → COMPLETE. |
| `fail(id, reason?)` | Any → FAILED. |
| `retry(id)` | Any → PENDING, increments `retryCount`. |
| `isComplete()` | `true` if queue is non-empty and every task is COMPLETE or FAILED. |

**Hydration**: on construction the queue loads all persisted tasks from `MemoryStore`. RUNNING tasks are reset to PENDING (crash recovery).

---

### `Executor` (`src/components/executor.ts`)

Calls Claude to implement a single task. The model returns JSON describing files to write and shell commands to run. The executor writes the files under `workspaceDir` and runs the commands (skipped in dry-run mode).

**dry-run output**: writes `dry-run/{taskId}.txt` to the workspace — a harmless placeholder.

---

### `Reviewer` (`src/components/reviewer.ts`)

Calls Claude to score completed task output (0–100). A score ≥ 70 with no `critical` critiques counts as `passed`. Failed reviews trigger a retry via `TaskQueue.retry()` (max 2 retries per task).

**dry-run output**: always returns score 85, passed: true, one low-severity placeholder critique.

---

### `TestRunner` (`src/components/test-runner.ts`)

Runs the test suite inside `workspaceDir` and returns a structured `TestReport`.

**Runner detection order**

1. `jest.config.ts / .js / .json` found → `npx jest --json --coverage`
2. `package.json` with jest dependency → `npx jest --coverage`
3. `package.json` with `scripts.test` → `npm test`
4. Neither found → returns an empty report immediately (no command run)

> **Important**: the workspace must contain its own `package.json` for the runner to execute. Without one, the runner exits early. This prevents `npm` from crawling up to a parent `package.json` and triggering unintended test runs.

---

### `CostOptimizer` (`src/components/cost-optimizer.ts`)

Tracks cumulative spend across all claude CLI calls and provides a prompt-level response cache backed by `MemoryStore`. Cost is recorded via `recordCost(usd)` using the value reported by the CLI; token-based estimation is used only for pre-call budget checks.

**Budget enforcement**: before every claude CLI call, `estimate()` is called. If the projected cost would exceed the remaining budget it returns `recommendedAction: 'skip'` and the caller must not proceed.

**Cache**: `buildCacheKey(...parts)` produces a 32-char SHA-256 hex key. `getCachedResponse` / `putCachedResponse` delegate to `MemoryStore.getCached` / `putCache`.

---

### `MemoryStore` (`src/components/memory-store.ts`)

File-system backed key-value store. No external services. Layout:

```
memory/
  state/project.json          ← single ProjectState document
  tasks/<uuid>.json           ← one file per task
  critiques/<uuid>.json       ← one file per Critique
  decisions/<uuid>.json       ← one file per ArchitectureDecision
  files/<path-hash>.json      ← metadata for each generated file
  cache/<sha256>.json         ← CostOptimizer response cache entries
```

---

## Data Flow

```
           ┌─────────────────────────────────┐
           │          LoopController          │
           │                                 │
  goal ───►│  initState() ──► MemoryStore    │
           │                                 │
           │  ┌── ITERATION N ─────────────┐ │
           │  │                            │ │
           │  │  Planner.plan()            │ │
           │  │    └─► claude CLI          │ │
           │  │    └─► TaskQueue.enqueueBatch│ │
           │  │    └─► MemoryStore.saveDecision│
           │  │                            │ │
           │  │  Executor.execute(task)    │ │
           │  │    └─► claude CLI          │ │
           │  │    └─► write files to workspace│
           │  │    └─► run shell commands  │ │
           │  │                            │ │
           │  │  TestRunner.run()          │ │
           │  │    └─► npx jest in workspace│ │
           │  │                            │ │
           │  │  Reviewer.review(task)     │ │
           │  │    └─► claude CLI          │ │
           │  │    └─► MemoryStore.saveCritique│
           │  │                            │ │
           │  │  CostOptimizer.isBudgetExceeded?│
           │  │  checkExitConditions?      │ │
           │  └────────────────────────────┘ │
           │                                 │
           │  return LoopExitReason          │
           └─────────────────────────────────┘
```

---

## Memory Layout

```
<project-root>/
  .goalforge/
    memory/
      state/project.json
      tasks/
      critiques/
      decisions/
      files/
      cache/
  <your generated code lives directly here, at the project root>
```

Paths are configured via `workspaceDir` and `memoryDir` in `LoopConfig`. Tests write to isolated temp directories and clean up in `beforeEach` and `afterAll`.

> **Note**: `.goalforge` is automatically added to `.gitignore` on first run.

---

## Exit Conditions

The loop exits (returning a `LoopExitReason`) when the first of these is true:

| Reason | Condition |
|--------|-----------|
| `no-critical-issues` | `coveragePercent >= targetCoveragePercent` AND `testsPassing` AND `criticalIssueCount <= maxCriticalIssues` |
| `all-tasks-complete` | Queue is complete (all COMPLETE/FAILED) AND at least one task was completed |
| `cost-exceeded` | `totalSpendUsd >= maxCostUsd` (checked after execute phase and after cost phase) |
| `max-iterations` | Loop counter reaches `maxIterations` |
| `user-quit` | User typed `quit` at the interactive pause or finish prompt |
| `user-redo` | User typed `redo` at the interactive pause or finish prompt; the outer `main()` loop restarts with an updated goal |

---

## Configuration

All configuration lives in `LoopConfig`. Set via environment variables when using the default `index.ts` entry point.

| Env var | Default | Description |
|---------|---------|-------------|
| `GOAL` | `'Build a production-ready stock fundamental analysis application'` | What the loop tries to build |
| `PROJECT_ID` | `project-<timestamp>` | Unique identifier for memory persistence |
| `MAX_ITERATIONS` | `20` | Hard cap on loop iterations |
| `MAX_COST_USD` | `10` | Spend cap in USD as reported by the claude CLI (subscription billing — governs usage, not direct charges) |
| `TARGET_COVERAGE` | `95` | Test coverage % needed to exit cleanly |
| `DRY_RUN` | `false` | Set to `true` to skip all claude CLI calls and file writes |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR` |

Budget constants (not env-configurable without code change):

```ts
// src/core/config.ts
DEFAULT_BUDGET = {
  maxCostUsd: 10.0,
  maxInputTokensPerCall: 100_000,
  maxOutputTokensPerCall: 8_000,
  warnThresholdPercent: 80,
}
```

Model: determined by the `claude` CLI session (whichever model your Claude.ai subscription uses by default).

---

## Running Locally

**Prerequisites**: Node.js 20+, the `claude` CLI installed and logged in (`claude login`).

No `ANTHROPIC_API_KEY` is required. The orchestrator calls Claude via the `claude` CLI, which uses your Claude.ai subscription (Pro/Teams) for authentication.

```bash
cd engine

# Install dependencies
npm install

# Build TypeScript
npm run build

# Dry run (no Claude calls, no file writes)
DRY_RUN=true npm start

# Real run — run from your project directory, files land in place
cd ~/my-project
GOAL="Build a REST API for user authentication" goalforge "Build a REST API for user authentication"

# Override budget and iteration limit
goalforge --iter 10 --cost 5 "Build a REST API for user authentication"

# Resume an interrupted run
goalforge resume
```

Generated code is written into `process.cwd()` — the directory you run the command from. Persistent state is stored in `.goalforge/memory/` inside the same directory.

---

## Testing

```bash
cd engine

# Run all tests with coverage
npm test

# Watch mode
npm run test:watch
```

**Coverage thresholds** (enforced by jest):

| Metric | Threshold |
|--------|-----------|
| Lines | 70% |
| Functions | 70% |
| Branches | 60% |
| Statements | 70% |

**Test isolation**: each test suite writes to its own temp directory (e.g. `task-queue-test-tmp/`) and cleans it up in both `beforeEach` and `afterAll`. Do not share `MemoryStore` instances or temp directories across test suites.

---

## Extending the System

### Swap in a different model

Pass `--model <model-id>` in the `spawn` call inside `src/components/claude-cli.ts`. The default is the model your `claude` CLI session is configured to use.

### Add a new phase to the loop

1. Add the method to `LoopController` following the existing phase pattern.
2. Call it inside the `while` loop in `run()`.
3. If it can trigger an early exit, return a `LoopExitReason`; otherwise return `null`.

### Add a new exit condition

Add a branch to `checkExitConditions()` and add the new reason string to the `LoopExitReason.reason` union type in `src/core/types.ts`.

### Change the planner prompt

Edit `SYSTEM_PROMPT` in `src/components/planner.ts`. The JSON schema returned by the model must match `PlannerResponse`; update both if you change the shape.

### Persist additional data

Add a new subdirectory constant to `MemoryStore.dirs`, create the directory in the constructor, and add typed `save*` / `load*` methods following the existing pattern.
