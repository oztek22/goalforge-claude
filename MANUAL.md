# GoalForge — User Manual

Describe the goal. Claude builds it. No API key needed.

GoalForge takes a plain-English goal and autonomously produces working code — decomposing tasks, writing files, running tests, evaluating output, and iterating until quality criteria are met or the usage cap is reached.

---

## What Does It Do?

Given a goal like:

> "Build a REST API for tracking personal expenses"

GoalForge:

1. **Plans** — breaks the goal into a prioritised list of concrete tasks
2. **Builds** — writes code for each task sequentially
3. **Tests** — runs the test suite automatically
4. **Reviews** — evaluates its own output and corrects problems
5. **Repeats** — cycles through steps 1–4 until coverage and review criteria pass, the budget cap is reached, or the iteration limit is hit

Generated files land directly in the directory where the tool is invoked (the project root).

---

## Before Starting

Requirements:

- **Node.js 20 or newer** ([nodejs.org](https://nodejs.org))
- **Claude Code CLI** installed and authenticated — no API key required
- A terminal (Terminal on Mac, Command Prompt or PowerShell on Windows)

Claude calls are covered by a Claude.ai subscription (Pro or Teams). There is no separate API key or per-call billing.

### Installing the Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

Follow the browser prompt to authenticate with a Claude.ai account. The session persists — re-authentication is only required on expiry.

---

## First-Time Setup

### Option A — install from npm (recommended)

```bash
npm install -g goalforge-claude
```

The `goalforge` command is now available globally. Skip to **Running the Tool** below.

### Option B — run from source

```bash
cd engine
npm install
npm run build
```

---

## Running the Tool

### Quick start (npm install)

```bash
goalforge "Build a CLI app that converts CSV files to JSON"
```

### Quick start (from source)

```bash
cd engine
GOAL="Build a CLI app that converts CSV files to JSON" npm start
```

### Dry run — no AI calls, no cost

```bash
DRY_RUN=true npm start
```

Runs the full loop with placeholder outputs. Useful for validating the task breakdown before committing subscription allowance.

---

## Customising the Run

Environment variables set defaults; CLI flags override them.

| Setting | What it does | Default |
|---------|-------------|---------|
| `GOAL="..."` | Target goal | A stock analysis app |
| `MAX_COST_USD=5` | Usage cap in USD | 10 |
| `MAX_ITERATIONS=10` | Max planning + building rounds | 20 |
| `TARGET_COVERAGE=80` | Test coverage % before exit | 95 |
| `DRY_RUN=true` | Skip AI calls (setup validation) | false |

**Example** — build something specific, cap at $3, stop after 5 rounds:

```bash
GOAL="Build a weather dashboard that fetches data from an API" \
MAX_COST_USD=3 \
MAX_ITERATIONS=5 \
npm start
```

---

## Understanding the Output

Log lines follow a consistent format:

```
[INFO] [Planner] Planning tasks           ← goal is being decomposed into tasks
[INFO] [TaskQueue] Task enqueued          ← task added to the work queue
[INFO] [Executor] Executing task          ← code is being written for a task
[INFO] [TestRunner] Running tests         ← test suite executing
[INFO] [Reviewer] Review complete         ← diff has been evaluated
[INFO] [LoopController] Phase: COST       ← spend check against cap
[INFO] [LoopController] === LOOP EXIT: MAX-ITERATIONS === ← loop complete
```

`[WARN]` lines are non-fatal notices. `[ERROR]` lines indicate a problem that may affect the output.

### Exit conditions

| Message | Meaning |
|---------|---------|
| `no-critical-issues` | Review passed — quality target met |
| `all-tasks-complete` | All planned tasks finished |
| `max-iterations` | Iteration cap reached; partial output is in the project root |
| `cost-exceeded` | Usage cap reached; partial output is in the project root |

---

## Where Is My Code?

Generated files are written directly into the directory where the tool is invoked (the project root).

```
my-project/         ← run goalforge from here
  src/              ← generated source files
  package.json      ← generated or updated in place
  .goalforge/       ← tool state (gitignored automatically)
```

---

## What Gets Remembered

Run state is persisted to `.goalforge/memory/` inside the project directory:

```
.goalforge/memory/
```

Contents:
- Project state — which tasks are done, cumulative spend
- Architecture decisions made during planning
- Code review critiques
- AI response cache — deduplicates identical requests, reducing subscription usage

This directory is added to `.gitignore` on first run.

### Automatic cleanup

GoalForge keeps the memory folder bounded automatically:

- **After every iteration** — critiques for completed tasks are pruned; cache is evicted once it exceeds 200 entries
- **After a successful run** — task files, critiques, cache, and project state are wiped. Architecture decisions and the cross-run learning log are preserved. The next invocation from the same directory starts clean rather than attempting to resume a completed project

To start fresh on an incomplete run, delete `.goalforge/` before running again.

---

## Resuming a Stopped Run

If interrupted — force-quit, network failure, shutdown — resume from the same directory:

```bash
goalforge resume
```

State is read from `.goalforge/memory/`. Any task that was mid-execution is automatically reset and retried.

### Pausing mid-run

Press **Ctrl+C once** — the loop finishes its current AI call, then pauses.

At the prompt:
- **Enter** — continue as-is
- **Type feedback** — inject a note and continue (e.g. `focus on error handling`)
- **`redo`** — restart from scratch with the same goal
- **`redo <feedback>`** — restart with additional direction
- **`q`** — stop

After a normal exit, a finish prompt offers the same options.

---

## How Much Will It Cost?

Claude calls are covered by the Claude.ai subscription (Pro or Teams) — no per-call billing. Cost figures reported by the CLI are tracked against `MAX_COST_USD`. When cumulative spend hits the cap, the loop exits — preventing runaway iterations from consuming the subscription allowance.

Approximate tracked spend per run:

| Goal complexity | Rough tracked spend |
|----------------|---------------------|
| Small script or utility | $0.10 – $0.50 |
| Multi-file CLI tool | $0.50 – $2.00 |
| Web API with tests | $2.00 – $5.00 |
| Full application | $5.00 – $10.00 |

Default cap is **$10**. A warning is emitted at 80% of the cap; the loop halts at 100%.

---

## Common Issues

**"Cannot find module" error after `npm start`**  
The build step was skipped. Run `npm run build` first.

**The tool stops immediately with "Budget exhausted"**  
The cap is too low for the prompt size. Try `MAX_COST_USD=5` or higher, or narrow the goal.

**No code appears in the project directory**  
Confirm `DRY_RUN` is not set to `true` — dry-run mode writes only placeholder `.txt` files. Also verify the tool was invoked from the project root.

**The claude CLI is not authenticated**  
Run `claude login` and follow the browser prompt. If `claude` is not found: `npm install -g @anthropic-ai/claude-code`.

**Starting over**  
Delete `.goalforge/` in the project directory, then run again.

---

## Tips for Better Results

- **Be specific in the goal.** "Build a REST API for user authentication with JWT tokens, written in Node.js with Express" produces significantly better results than "Build an auth system".
- **Set a realistic cap.** `MAX_COST_USD=5` covers most small-to-medium tasks. The default $10 is generous but bounded.
- **Check output incrementally.** Files can be inspected while the tool is still running.
- **Use `DRY_RUN=true` first** on underspecified goals — it's free, fast, and shows exactly what tasks the planner would generate.
