<div align="center">

<img src="assets/readme-cover.svg" alt="GoalForge" width="900"/>

<br/>
<br/>

**Type a goal. Walk away. Come back to working code.**

GoalForge runs an autonomous 6-phase loop powered by the Claude CLI —  
no API key, no billing dashboard, just your existing Claude subscription.

<br/>

[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen?style=flat-square&labelColor=0d1117)](https://nodejs.org)
[![Claude CLI](https://img.shields.io/badge/requires-claude%20CLI-f97316?style=flat-square&labelColor=0d1117)](https://docs.anthropic.com/en/docs/claude-code)
[![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square&labelColor=0d1117)](#license)

</div>

---

## How it works

```
you type a goal
      │
      ▼
  ┌─────────────────────────────────────────────────────────┐
  │                    GoalForge loop                       │
  │                                                         │
  │  ① PLAN      Sonnet breaks goal into atomic tasks       │
  │      │                                                  │
  │      ▼                                                  │
  │  ② EXECUTE   Claude writes files, runs commands         │
  │      │                                                  │
  │      ▼                                                  │
  │  ③ TEST      Jest runs; coverage is measured            │
  │      │                                                  │
  │      ▼                                                  │
  │  ④ REVIEW    Haiku checks diff for regressions          │
  │      │                                                  │
  │      ▼                                                  │
  │  ⑤ EXIT?     all tasks done · goal met · budget hit     │
  │      │  no → back to ①                                  │
  │      ▼  yes                                             │
  │  ⑥ MEMORY    STATE.md updated, loop exits               │
  └─────────────────────────────────────────────────────────┘
      │
      ▼
  working code in ./workspace/
```

Each phase runs as a **fresh claude subprocess** — no shared context window, no token bleed between calls. The state machine is typed TypeScript that survives crashes and resumes mid-task.

---

## Key concepts

- **No API key** — uses `claude -p --output-format json` under the hood. Your Claude.ai subscription covers the cost.
- **Fresh context per phase** — Planner, Executor, and Reviewer each get a clean 200k-token window. Long-running projects never hit context limits.
- **Crash-resilient** — tasks marked `[~]` in-progress are reset to `[ ]` on resume. Pick up exactly where you left off.
- **Spend cap** — `--cost <N>` hard-stops the loop before you overshoot your budget.
- **Coverage gate** — the loop won't exit until Jest reports ≥ target line coverage (default 95%).
- **Retry tracking** — failed tasks get `(retries: N)` annotations. After 3 retries the task is marked `[F]` and skipped.

---

## Two modes

### Mode 1 — `goalforge` CLI (TypeScript orchestrator)

Full state machine. Runs indefinitely, survives context exhaustion, tracks spend, writes structured memory.

```bash
goalforge "Build a REST API with JWT auth"
```

Best for: **multi-hour, multi-file projects** where you want to walk away.

---

### Mode 2 — `/build` skill (native Claude Code)

A Claude Code slash command that mimics the same 6-phase loop using Claude's native tools (Write, Edit, Bash). No subprocess overhead, no separate install — just open Claude Code in any project directory.

```
/build --iter 5 "Add pagination to the users endpoint"
```

Best for: **quick focused tasks** inside an existing project where you're already in Claude Code.

---

## Install

### Prerequisites (both modes)

```bash
# Install the Claude CLI and log in — this is the only auth step
npm install -g @anthropic-ai/claude-code
claude login
```

Follow the browser prompt to sign in with your Claude.ai account. No API key. No credit card beyond your existing subscription.

---

### Installing the `goalforge` CLI (Mode 1)

```bash
# 1. Enter the engine directory
cd engine

# 2. Install dependencies
npm install

# 3. Compile TypeScript and make the binary executable
npm run build

# 4. Link it globally so `goalforge` works from anywhere
npm link
```

Verify:

```bash
goalforge --version
# goalforge v1.0.0
```

To uninstall:

```bash
npm unlink -g goalforge
```

#### Update from source

```bash
cd engine
git pull
npm run build   # re-compile; the global link auto-picks up the new dist/
```

---

### Installing the `/build` skill (Mode 2)

The skill is a single markdown file that teaches Claude Code a new slash command.

**Option A — use it from this repo (already installed)**

Open Claude Code in the `goalforge/` root. The skill is already at `.claude/commands/build.md`. Type `/build` to use it.

**Option B — copy it into another project**

```bash
# Inside any project you want to use /build in:
mkdir -p .claude/commands
cp /path/to/goalforge/.claude/commands/build.md .claude/commands/build.md
```

Then open that project in Claude Code and type `/build`.

**Option C — install it globally for all Claude Code projects**

```bash
mkdir -p ~/.claude/commands
cp /path/to/goalforge/.claude/commands/build.md ~/.claude/commands/build.md
```

`/build` will now be available in every Claude Code session.

---

## Using the CLI (Mode 1)

### Basic usage

```bash
goalforge "Build a REST API with JWT auth and SQLite"
```

### With flags

```bash
# Tight budget and fewer iterations
goalforge --iter 5 --cost 2 "Add input validation to the user endpoint"

# Resume a previous project by ID
goalforge --id my-api "Build a REST API with JWT auth and SQLite"

# Dry run — see the plan without calling Claude
goalforge --dry-run "Build a CLI markdown converter"

# Custom output directory
goalforge --workspace ~/projects/my-api "Build a REST API"
```

### All flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--iter <N>` | `-i` | `20` | Max loop iterations before forced exit |
| `--cost <N>` | `-c` | `10` | Spend cap in USD (subscription usage governor) |
| `--cover <N>` | `-k` | `95` | Target line coverage % |
| `--id <id>` | `-p` | auto | Project ID — set this to resume a prior run |
| `--workspace <path>` | | `./workspace` | Where generated code lands |
| `--dry-run` | `-d` | off | Skip all Claude calls; write placeholder files |
| `--version` | `-v` | | Print version and exit |
| `--help` | `-h` | | Show help and exit |

Environment variables (`GOAL`, `MAX_ITERATIONS`, `MAX_COST_USD`, `TARGET_COVERAGE`, `PROJECT_ID`, `DRY_RUN`) are read as defaults and overridden by flags.

---

## Using the skill (Mode 2)

Open Claude Code in any project, then type:

```
/build "Build a CLI tool that converts markdown to HTML"
```

### Skill flags

| Flag | Default | Description |
|------|---------|-------------|
| `--iter N` | `20` | Max loop iterations |
| `--tasks N` | unlimited | Max tasks the planner generates per batch |
| `--coverage N` | `95` | Target line coverage % |
| `--light` | off | Shorthand for `--iter 3 --tasks 5 --coverage 0` (fast cheap run) |

```
/build --light "Scaffold a basic Express server"
/build --iter 10 --tasks 8 --coverage 80 "Build a CLI tool"
```

---

## Directory layout

```
goalforge/                         # project root
├── engine/                        # TypeScript state machine (Mode 1)
│   ├── src/
│   │   ├── index.ts               # CLI entry point + flag parser
│   │   ├── loop-controller.ts     # 6-phase state machine
│   │   ├── components/
│   │   │   ├── claude-cli.ts      # claude subprocess wrapper
│   │   │   ├── planner.ts         # Phase 1: Sonnet task decomposition
│   │   │   ├── executor.ts        # Phase 2: code generation
│   │   │   ├── test-runner.ts     # Phase 3: Jest + coverage
│   │   │   ├── reviewer.ts        # Phase 4: Haiku diff review
│   │   │   └── cost-optimizer.ts  # spend tracking + prompt cache
│   │   └── core/
│   │       ├── config.ts          # defaults + loop config type
│   │       ├── logger.ts          # structured JSON logger
│   │       └── types.ts           # shared TypeScript types
│   ├── tests/                     # Jest test suite
│   ├── package.json               # name: "goalforge", bin: "goalforge"
│   └── README.md                  # engineer reference
│
├── .claude/
│   └── commands/
│       └── build.md               # /build skill (Mode 2)
│
├── workspace/                     # generated code lands here
│   └── <project>/
│       ├── .build/
│       │   ├── BACKLOG.md         # [ ] [~] [x] [F] task checklist
│       │   ├── STATE.md           # loop state snapshot
│       │   └── DECISIONS.md       # architecture log
│       └── <your generated files>
│
├── assets/
│   └── readme-cover.svg           # cover image
├── MANUAL.md                      # non-engineer user guide
└── README.md                      # this file
```

---

## How the `/build` skill stores state

The skill writes state to `./workspace/.build/` using three markdown files:

| File | Purpose |
|------|---------|
| `BACKLOG.md` | Task checklist. Markers: `[ ]` pending · `[~]` in-progress · `[x]` done · `[F]` failed |
| `STATE.md` | Loop snapshot: iteration, cost, coverage, exit reason |
| `DECISIONS.md` | Running log of architectural choices |

On resume, `[~]` tasks are reset to `[ ]` so no task is silently abandoned after a crash.

Retry tracking: tasks that fail are annotated `(retries: N)`. At `retries: 3` the task is marked `[F]` and the loop moves on.

---

## Cost model

GoalForge uses the `claude` CLI, which authenticates via your Claude.ai subscription — **no `ANTHROPIC_API_KEY` is required, and there is no per-token billing.**

The `--cost` flag is a **usage governor**: it reads the cost reported by the CLI after each call and stops the loop if cumulative spend exceeds the cap. Set it based on how much of your subscription allowance you want to dedicate to a single run.

```bash
goalforge --cost 3 "Build a REST API"   # stop after ~$3 of subscription usage
goalforge --cost 0.5 "Fix this bug"     # tight cap for a quick task
```

---

## Extending

**Use a different model** — edit the `spawn('claude', [...])` call in `engine/src/components/claude-cli.ts` and add `--model <model-id>`.

**Add a phase** — add a new method to `LoopController`, wire it into the `run()` loop, and add the corresponding component in `engine/src/components/`.

**Change the planner prompt** — edit `SYSTEM_PROMPT` in `engine/src/components/planner.ts`.

**Swap the test runner** — `TestRunner` in `engine/src/components/test-runner.ts` detects Jest automatically. Replace the jest invocation with your own test command.

---

## Credits

Built with [Claude Code](https://claude.ai/code) — the same tool it automates.

Inspired by the autonomous agent loop pattern pioneered by projects like [goal-forge](https://github.com/goal-forge/goal-forge).

---

## License

MIT © 2026
