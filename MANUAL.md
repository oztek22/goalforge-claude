# GoalForge — User Manual

Describe what you want. Claude builds it. No API key needed.

GoalForge takes a plain-English description of a software project and autonomously builds it using AI. You describe what you want; it writes the code, tests it, reviews it, and keeps refining until the result meets quality standards or the usage cap is reached.

---

## What Does It Do?

You give the tool a goal like:

> "Build a REST API for tracking personal expenses"

It then:

1. **Plans** — breaks the goal into a prioritised list of concrete tasks
2. **Builds** — writes code for each task, one at a time
3. **Tests** — runs the code's test suite automatically
4. **Reviews** — critiques its own output and fixes problems
5. **Repeats** — keeps cycling through steps 1–4 until the code meets the quality bar, the money runs out, or it runs out of attempts

All the generated code lands in a `workspace/` folder next to this manual.

---

## Before You Start

You need:

- **Node.js 20 or newer** installed ([nodejs.org](https://nodejs.org))
- **Claude Code CLI** installed and logged in — no API key required
- A terminal (Terminal on Mac, Command Prompt or PowerShell on Windows)

The tool calls Claude through the `claude` CLI, which uses your Claude.ai subscription (Pro or Teams). There is no separate API key to manage.

### Installing the Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

Follow the browser prompt to sign in with your Claude.ai account. Once logged in, the CLI stores your session — you will not need to log in again unless the session expires.

---

## First-Time Setup

Open a terminal, navigate to this project, then run:

```bash
cd engine
npm install
npm run build
```

You only need to do this once.

---

## Running the Tool

### Quick start

```bash
cd engine
GOAL="Build a CLI app that converts CSV files to JSON" npm start
```

Replace the text in quotes with your own goal. The tool will start logging its progress immediately.

### Dry run (free — no AI calls)

To see how the tool works without spending any money or writing real code:

```bash
DRY_RUN=true npm start
```

This runs the full loop with placeholder outputs. Great for checking your setup.

---

## Customising the Run

You can control the tool's behaviour with these settings, placed before `npm start`:

| Setting | What it does | Default |
|---------|-------------|---------|
| `GOAL="..."` | What you want built | A stock analysis app |
| `MAX_COST_USD=5` | Maximum dollars to spend on AI | 10 |
| `MAX_ITERATIONS=10` | How many rounds of planning + building to do | 20 |
| `TARGET_COVERAGE=80` | Test coverage % to aim for before stopping | 95 |
| `DRY_RUN=true` | Skip real AI calls (for testing your setup) | false |

**Example** — build something specific, spend at most $3, stop after 5 rounds:

```bash
GOAL="Build a weather dashboard that fetches data from an API" \
MAX_COST_USD=3 \
MAX_ITERATIONS=5 \
npm start
```

---

## Understanding the Output

While running, the tool prints coloured log lines. Here is what they mean:

```
[INFO] [Planner] Planning tasks           ← AI is breaking the goal into tasks
[INFO] [TaskQueue] Task enqueued          ← a task has been added to the work list
[INFO] [Executor] Executing task          ← AI is writing code for a task
[INFO] [TestRunner] Running tests         ← tests are being run on the code
[INFO] [Reviewer] Review complete         ← AI has reviewed the code
[INFO] [LoopController] Phase: COST       ← checking how much has been spent
[INFO] [LoopController] === LOOP EXIT: MAX-ITERATIONS === ← the tool has finished
```

Yellow (`[WARN]`) lines are non-fatal notices. Red (`[ERROR]`) lines indicate a problem that may affect the result.

### How it ends

When the tool finishes it prints one of these exit messages:

| Message | Meaning |
|---------|---------|
| `no-critical-issues` | The code meets the quality target — done successfully |
| `all-tasks-complete` | Every planned task was finished |
| `max-iterations` | Hit the round limit; partial output is in `workspace/` |
| `cost-exceeded` | Ran out of budget; partial output is in `workspace/` |

---

## Where Is My Code?

Everything the tool generates is saved in the `workspace/` folder at the top level of this project (the same level as this manual).

```
goalforge/
  workspace/    ← your generated code is here
  engine/       ← the tool itself (don't edit)
  MANUAL.md     ← this file
```

---

## What Gets Remembered

The tool keeps a memory of its work so it can resume if interrupted. This memory is stored in:

```
engine/memory/
```

It contains:
- The current state of the project (which tasks are done, how much was spent)
- A log of architecture decisions made during planning
- The code review critiques
- A cache of AI responses (so identical requests aren't re-sent to Claude, saving time and subscription allowance)

To start completely fresh on the same goal, delete the `engine/memory/` folder before running again.

---

## Resuming a Stopped Run

If the tool is interrupted (Ctrl+C, network error, computer shutdown), just run it again with the same `GOAL` and `PROJECT_ID`. It will pick up where it left off.

```bash
GOAL="Build a CLI app that converts CSV files to JSON" \
PROJECT_ID=my-csv-project \
npm start
```

Using `PROJECT_ID` lets you have multiple separate projects tracked independently.

---

## How Much Will It Cost?

Claude calls are covered by your **Claude.ai subscription** (Pro or Teams) — there is no separate per-call billing. The tool does track the cost figures reported by the CLI for each call and compares them against `MAX_COST_USD`. This acts as a **usage governor**: the tool stops itself when the tracked spend reaches the cap, preventing runaway loops from consuming your subscription allowance.

Approximate tracked spend per run (based on CLI-reported values):

| Goal complexity | Rough tracked spend |
|----------------|---------------------|
| Small script or utility | $0.10 – $0.50 |
| Multi-file CLI tool | $0.50 – $2.00 |
| Web API with tests | $2.00 – $5.00 |
| Full application | $5.00 – $10.00 |

The default cap is **$10**. Set `MAX_COST_USD` lower if you want the tool to stop sooner.

The tool warns you at 80% of the cap and stops automatically when the limit is reached.

---

## Common Issues

**"Cannot find module" error after `npm start`**
You may have skipped the build step. Run `npm run build` first.

**The tool stops immediately with "Budget exhausted"**
Your budget is set too low for the prompt size. Try `MAX_COST_USD=5` or more, or simplify the goal.

**No code appears in `workspace/`**
Check that `DRY_RUN` is not set to `true`. In dry-run mode the tool creates only placeholder `.txt` files.

**The claude CLI is not authenticated**
Run `claude login` and follow the browser prompt. If `claude` is not found, install it first: `npm install -g @anthropic-ai/claude-code`.

**I want to start over**
Delete `engine/memory/` and optionally `workspace/`, then run again.

---

## Tips for Better Results

- **Be specific in your goal.** "Build a REST API for user authentication with JWT tokens, written in Node.js with Express" works much better than "Build an auth system".
- **Set a realistic cap.** `MAX_COST_USD=5` is usually enough for a small but complete project — the default $10 cap is generous but prevents runaway loops.
- **Check the workspace incrementally.** You can open files in `workspace/` while the tool is still running to see what has been written.
- **Use `DRY_RUN=true` first** if you are not sure your goal is well-specified — it runs fast and free, and shows you the task breakdown the AI would plan.
