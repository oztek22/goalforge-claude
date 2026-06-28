#!/usr/bin/env node
import { join } from 'path';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import * as readline from 'readline';
import { LoopController } from './loop-controller';
import { defaultLoopConfig } from './core/config';
import { createLogger } from './core/logger';
import { InteractiveSession } from './components/interactive';
import { callClaude } from './components/claude-cli';
import { cleanupAfterSuccess, isSuccessExit } from './components/cleanup';
import { LoopExitReason } from './core/types';
import * as StatusBar from './core/status-bar';

const VERSION = '1.2.1';

const UPSTREAM_REPO = 'oztek22/goalforge-claude';
const UPSTREAM_URL  = `https://github.com/${UPSTREAM_REPO}`;

const HELP = `
GoalForge — Describe what you want. Claude builds it. No API key needed.

Usage:
  goalforge                                 Study codebase and improve it autonomously
  goalforge <goal>                          Run with a specific goal
  goalforge resume                          Resume the last interrupted run
  goalforge contribute                      Fork GoalForge, improve it, open a PR
  goalforge --dry-run <goal>                Dry run (no Claude calls)
  goalforge --iter 5 --cost 3 <goal>        Custom limits

Options:
  <goal>                 What to build (omit to let GoalForge discover improvements)
  --iter,  -i  <N>       Max loop iterations          (default: 20)
  --cost,  -c  <N>       Max spend cap in USD          (default: 10)
  --cover, -k  <N>       Target line coverage %        (default: 95)
  --timeout, -t <N>      Claude CLI timeout in seconds (default: 600)
  --dry-run, -d          Skip Claude calls, write placeholders
  --debug,   -D          Verbose logging: show prompts, raw responses, exit codes
  --workspace <path>     Working directory              (default: current directory)
  --version, -v          Show version
  --help,    -h          Show this help

Environment variables (overridden by flags):
  GOAL, MAX_ITERATIONS, MAX_COST_USD, TARGET_COVERAGE, DRY_RUN, CLAUDE_TIMEOUT_MS
  LOG_LEVEL=DEBUG        Enable debug log level
  GOALFORGE_DEBUG=true   Verbose Claude CLI logging (prompts, responses, exit codes)

Examples:
  goalforge "Build a REST API with JWT auth"
  goalforge
  goalforge resume
  goalforge contribute
  goalforge --iter 3 --cost 2 "Scaffold an Express server"
`;

interface ParsedArgs {
  goal: string;
  maxIterations: number;
  maxCostUsd: number;
  targetCoverage: number;
  claudeTimeoutMs: number;
  projectId: string;
  dryRun: boolean;
  workspace: string;
  isResume: boolean;
  isAutoDiscover: boolean;
  isContribute: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`goalforge v${VERSION}\n`);
    process.exit(0);
  }

  let maxIterations = Number(process.env.MAX_ITERATIONS ?? 20);
  let maxCostUsd = Number(process.env.MAX_COST_USD ?? 10);
  let targetCoverage = Number(process.env.TARGET_COVERAGE ?? 95);
  let claudeTimeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 600_000);
  let projectId = process.env.PROJECT_ID ?? `project-${Date.now()}`;
  let dryRun = process.env.DRY_RUN === 'true';
  let workspace = process.cwd();
  let isResume = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--iter': case '-i':      maxIterations = Number(args[++i]); break;
      case '--cost': case '-c':      maxCostUsd = Number(args[++i]); break;
      case '--cover': case '-k':     targetCoverage = Number(args[++i]); break;
      case '--timeout': case '-t':   claudeTimeoutMs = Number(args[++i]) * 1000; break;
      case '--workspace':            workspace = args[++i]; break;
      case '--dry-run': case '-d':   dryRun = true; break;
      case '--debug':   case '-D':
        process.env.LOG_LEVEL = 'DEBUG';
        process.env.GOALFORGE_DEBUG = 'true';
        break;
      default:
        if (!a.startsWith('-')) positional.push(a);
        else { process.stderr.write(`Unknown flag: ${a}\n${HELP}\n`); process.exit(1); }
    }
  }

  if (positional[0] === 'resume') {
    isResume = true;
    return { goal: '', maxIterations, maxCostUsd, targetCoverage, claudeTimeoutMs, projectId, dryRun, workspace, isResume, isAutoDiscover: false, isContribute: false };
  }

  if (positional[0] === 'contribute') {
    return { goal: '', maxIterations, maxCostUsd, targetCoverage, claudeTimeoutMs, projectId, dryRun, workspace, isResume: false, isAutoDiscover: false, isContribute: true };
  }

  const goal = positional.join(' ') || process.env.GOAL || '';
  const isAutoDiscover = !goal;

  return { goal, maxIterations, maxCostUsd, targetCoverage, claudeTimeoutMs, projectId, dryRun, workspace, isResume, isAutoDiscover, isContribute: false };
}

interface SavedState {
  projectId: string;
  goal: string;
  iterationCount: number;
  totalCostUsd: number;
  completedTaskIds: string[];
  failedTaskIds: string[];
  currentPhase: string;
}

function loadSavedState(workspace: string): SavedState | null {
  const statePath = join(workspace, '.goalforge', 'memory', 'state', 'project.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as SavedState;
  } catch {
    return null;
  }
}

/**
 * Returns the saved state only when the task queue has unfinished work
 * (at least one PENDING, RUNNING, or BLOCKED task). Returns null when the
 * previous run completed cleanly or no state exists.
 */
function hasPendingWork(workspace: string): SavedState | null {
  const state = loadSavedState(workspace);
  if (!state) return null;

  const tasksDir = join(workspace, '.goalforge', 'memory', 'tasks');
  if (!existsSync(tasksDir)) return null;

  try {
    const hasPending = readdirSync(tasksDir)
      .filter((f) => f.endsWith('.json'))
      .some((f) => {
        try {
          const task = JSON.parse(readFileSync(join(tasksDir, f), 'utf-8')) as { status?: string };
          return task.status === 'PENDING' || task.status === 'RUNNING' || task.status === 'BLOCKED';
        } catch {
          return false;
        }
      });
    return hasPending ? state : null;
  } catch {
    return null;
  }
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, '.gitignore');
  const entry = '.goalforge';
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.split('\n').some((l) => l.trim() === entry)) {
      writeFileSync(gitignorePath, content.trimEnd() + '\n' + entry + '\n', 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, entry + '\n', 'utf-8');
  }
}

const log = createLogger('GoalForge');

function formatExitSummary(exit: LoopExitReason): string {
  const s = exit.finalState;
  return [
    `  Exit reason  : ${exit.reason}`,
    `  Iterations   : ${s.iterationCount}`,
    `  Tasks done   : ${s.completedTaskIds.length}  failed: ${s.failedTaskIds.length}`,
    `  Tests passing: ${s.testsPassing ? 'yes' : 'no'}`,
    `  Coverage     : ${s.coveragePercent}%`,
    `  Cost         : $${s.totalCostUsd.toFixed(4)}`,
  ].join('\n');
}

// ── Shared readline helper ───────────────────────────────────────────────────

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.once('SIGINT', () => { rl.close(); process.exit(130); });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ── goalforge contribute ─────────────────────────────────────────────────────

async function runContribute(parentDir: string, claudeTimeoutMs: number): Promise<void> {
  const REPO_DIR = join(parentDir, 'goalforge-claude');

  // ── Prerequisites ──────────────────────────────────────────────────────────
  try { execSync('gh --version', { stdio: 'ignore' }); }
  catch {
    process.stderr.write(
      '\nError: GitHub CLI (gh) is required for goalforge contribute.\n' +
      '  Install  : https://cli.github.com\n' +
      '  Auth     : gh auth login\n\n'
    );
    process.exit(1);
  }

  try { execSync('gh auth status', { stdio: 'ignore' }); }
  catch {
    process.stderr.write('\nError: gh is not authenticated. Run: gh auth login\n\n');
    process.exit(1);
  }

  // ── Fork + clone ────────────────────────────────────────────────────────────
  if (existsSync(REPO_DIR)) {
    log.info(`Existing clone found at ${REPO_DIR} — pulling latest`);
    execSync('git pull --ff-only', { cwd: REPO_DIR, stdio: 'inherit' });
  } else {
    log.info(`Forking and cloning ${UPSTREAM_REPO}...`);
    execSync(`gh repo fork ${UPSTREAM_REPO} --clone --default-branch-only`, {
      cwd: parentDir, stdio: 'inherit',
    });
  }

  // ── Build the engine so it can operate on itself ──────────────────────────
  const engineDir = join(REPO_DIR, 'engine');
  log.info('Installing and building engine...');
  execSync('npm install && npm run build', { cwd: engineDir, stdio: 'inherit' });

  // ── Ask what to improve ───────────────────────────────────────────────────
  process.stdout.write(
    '\n╔══════════════════════════════════════════════════════╗\n' +
    '║           🤝  GoalForge Contribute                   ║\n' +
    '╚══════════════════════════════════════════════════════╝\n\n' +
    `  Repo cloned to: ${REPO_DIR}\n\n` +
    '  What improvement would you like to contribute?\n' +
    '  Be specific — this becomes the autonomous loop goal.\n\n'
  );

  const goal = await promptLine('> ');
  if (!goal) {
    process.stdout.write('No goal provided. Exiting.\n');
    process.exit(0);
  }

  // ── Branch ────────────────────────────────────────────────────────────────
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const branch = `contribute/${slug}-${Date.now()}`;
  execSync(`git checkout -b "${branch}"`, { cwd: REPO_DIR, stdio: 'inherit' });
  log.info(`Branch created: ${branch}`);

  // ── Run the loop on the cloned repo ───────────────────────────────────────
  const session = new InteractiveSession();
  session.attach();
  StatusBar.init(20);

  const config = defaultLoopConfig({
    goal,
    workspaceDir: REPO_DIR,
    memoryDir: join(REPO_DIR, '.goalforge', 'memory'),
    claudeTimeoutMs,
  });

  const controller = new LoopController(config, session);
  let exit: LoopExitReason;
  try {
    exit = await controller.run();
  } catch (err) {
    log.error('Loop failed during contribute', { err: String(err) });
    process.exit(1);
  }

  if (exit.reason === 'user-quit') {
    process.stdout.write('\n[GoalForge] Contribute cancelled.\n');
    process.exit(0);
  }

  // ── Changelog ─────────────────────────────────────────────────────────────
  appendToChangelog(REPO_DIR, join(REPO_DIR, '.goalforge', 'memory'), goal);

  // ── Commit ────────────────────────────────────────────────────────────────
  execSync('git add -A', { cwd: REPO_DIR, stdio: 'pipe' });
  const status = execSync('git status --porcelain', { cwd: REPO_DIR, encoding: 'utf-8' });
  if (!status.trim()) {
    log.warn('No file changes detected — skipping commit and PR');
    process.exit(0);
  }

  const safeTitle = goal.slice(0, 72).replace(/"/g, "'");
  execSync(`git commit -m "feat: ${safeTitle}"`, { cwd: REPO_DIR, stdio: 'inherit' });

  // ── Push ──────────────────────────────────────────────────────────────────
  execSync(`git push -u origin "${branch}"`, { cwd: REPO_DIR, stdio: 'inherit' });

  // ── Open PR ───────────────────────────────────────────────────────────────
  const prBody = [
    '## Summary',
    '',
    'Automated contribution via `goalforge contribute`.',
    '',
    `**Goal:** ${goal}`,
    '',
    '## Details',
    '',
    `| | |`,
    `|---|---|`,
    `| Exit reason | ${exit.reason} |`,
    `| Iterations | ${exit.finalState.iterationCount} |`,
    `| Tasks completed | ${exit.finalState.completedTaskIds.length} |`,
    `| Cost | $${exit.finalState.totalCostUsd.toFixed(4)} |`,
    '',
    '---',
    `_Generated with [GoalForge](${UPSTREAM_URL})_`,
  ].join('\n');

  const prBodyPath = join(REPO_DIR, '.goalforge', 'pr-body.md');
  writeFileSync(prBodyPath, prBody, 'utf-8');

  const prUrl = execSync(
    `gh pr create --repo ${UPSTREAM_REPO} --title "${safeTitle}" --body-file "${prBodyPath}"`,
    { cwd: REPO_DIR, encoding: 'utf-8' }
  ).trim();

  process.stdout.write(`\n✓ Pull request created: ${prUrl}\n`);
}

// ── Auto-discover: study the codebase and derive a goal ─────────────────────

async function discoverGoal(workspace: string, dryRun: boolean): Promise<string> {
  if (dryRun) {
    return 'Improve code quality, add missing tests, and fix any identified issues in the codebase';
  }

  log.info('No goal provided — studying codebase to discover improvements...');

  let fileTree = '(could not list files)';
  try {
    fileTree = execSync(
      `find . -type f` +
      ` -not -path "./.goalforge/*"` +
      ` -not -path "./node_modules/*"` +
      ` -not -path "./.git/*"` +
      ` -not -path "./dist/*"` +
      ` -not -path "./build/*"` +
      ` | sort | head -60`,
      { encoding: 'utf-8', cwd: workspace }
    );
  } catch { /* ignore */ }

  const snippets: string[] = [];
  for (const name of ['package.json', 'README.md', 'src/index.ts', 'src/index.js', 'index.ts', 'index.js', 'app.ts', 'app.js']) {
    const fp = join(workspace, name);
    if (existsSync(fp)) {
      try {
        snippets.push(`\`\`\` ${name}\n${readFileSync(fp, 'utf-8').slice(0, 1500)}\n\`\`\``);
      } catch { /* skip */ }
    }
  }

  const FALLBACK_GOAL = 'Analyse the codebase and improve code quality, error handling, and test coverage';

  let result: { text: string };
  try {
    result = await callClaude(
      `You are a senior software engineer auditing a project to find the most valuable improvement to make right now.

File tree:
${fileTree}

${snippets.join('\n\n')}`,
      `Identify the single most impactful improvement for this codebase.
Consider: missing tests, unhandled errors, incomplete features, poor documentation, performance issues, security gaps, or technical debt.
Return ONLY a clear, specific, actionable goal (1–2 sentences). No markdown, no explanation — just the goal text.`
    );
  } catch (err) {
    log.warn('Auto-discover Claude call failed — using fallback goal', { err: String(err) });
    return FALLBACK_GOAL;
  }

  const goal = result.text.trim() || FALLBACK_GOAL;
  log.info('Discovered goal', { goal: goal.slice(0, 80) });
  return goal;
}

// ── Changelog + run log ──────────────────────────────────────────────────────

interface TaskRecord {
  status?: string;
  objective?: string;
  result?: { output?: string; filesCreated?: string[] };
  retryCount?: number;
}

function categoriseObjective(objective: string): 'Added' | 'Changed' | 'Fixed' {
  const lc = objective.toLowerCase();
  if (/^(fix|repair|resolve|correct|patch|address bug|handle error)/.test(lc)) return 'Fixed';
  if (/^(add|create|implement|write|introduce|build|generate|scaffold|set up|initialise|initialize)/.test(lc)) return 'Added';
  return 'Changed';
}

/**
 * Derive a short human-readable summary of what was accomplished.
 * One bullet per category (Added / Changed / Fixed), capped at a handful of words each.
 */
function goalSummaryLine(goal: string): string {
  // Take the first sentence / clause of the goal, max 80 chars
  const first = goal.split('\n')[0].replace(/[.!?].*$/, '').trim();
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

function appendToChangelog(workspace: string, memoryDir: string, goal: string): void {
  const changelogPath = join(workspace, 'CHANGELOG.md');
  const tasksDir = join(memoryDir, 'tasks');

  const tasks: TaskRecord[] = [];
  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir).filter(f => f.endsWith('.json'))) {
      try {
        tasks.push(JSON.parse(readFileSync(join(tasksDir, file), 'utf-8')) as TaskRecord);
      } catch { /* skip corrupt file */ }
    }
  }

  const completed = tasks.filter(t => t.status === 'COMPLETE' && t.objective);
  if (completed.length === 0) return;

  const date = new Date().toISOString().slice(0, 10);

  // ── Write detailed run log to logs/ ────────────────────────────────────────
  const logsDir = join(workspace, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = join(logsDir, `goalforge-${ts}.md`);

  const byCategory: Record<'Added' | 'Changed' | 'Fixed', TaskRecord[]> = { Added: [], Changed: [], Fixed: [] };
  for (const t of completed) {
    byCategory[categoriseObjective(t.objective!)].push(t);
  }

  const logLines: string[] = [
    `# GoalForge run — ${date}`,
    '',
    `**Goal:** ${goal.split('\n')[0].slice(0, 200)}`,
    `**Tasks completed:** ${completed.length}`,
    '',
  ];
  for (const cat of ['Added', 'Changed', 'Fixed'] as const) {
    if (byCategory[cat].length === 0) continue;
    logLines.push(`## ${cat}`, '');
    for (const t of byCategory[cat]) {
      logLines.push(`### ${t.objective}`);
      if (t.result?.output) logLines.push('', t.result.output);
      if (t.result?.filesCreated?.length) {
        logLines.push('', '**Files:**');
        t.result.filesCreated.forEach(f => logLines.push(`- \`${f}\``));
      }
      logLines.push('');
    }
  }
  writeFileSync(logPath, logLines.join('\n'), 'utf-8');

  // ── Write one short bullet to CHANGELOG.md ─────────────────────────────────
  const summary = goalSummaryLine(goal);
  // Pick the dominant category (most tasks) for the bullet prefix
  const cats: Array<'Added' | 'Changed' | 'Fixed'> = ['Added', 'Changed', 'Fixed'];
  const dominantCat = cats.sort((a, b) => byCategory[b].length - byCategory[a].length)[0];

  const bullet = `- **[${dominantCat}]** ${summary}`;
  const entry = `\n${bullet}\n`;

  let content = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf-8') : '';

  if (content.includes('## [Unreleased]')) {
    const idx = content.indexOf('## [Unreleased]') + '## [Unreleased]'.length;
    content = content.slice(0, idx) + entry + content.slice(idx);
  } else {
    const firstH2 = content.indexOf('\n## ');
    if (firstH2 !== -1) {
      content = content.slice(0, firstH2) + '\n\n## [Unreleased]\n' + entry + content.slice(firstH2);
    } else if (content.length > 0) {
      content = content.trimEnd() + '\n\n## [Unreleased]\n' + entry;
    } else {
      content = `# Changelog\n\n## [Unreleased]\n${entry}`;
    }
  }

  writeFileSync(changelogPath, content, 'utf-8');
  log.info('Changelog updated', { path: changelogPath });
  log.info('Run log written', { path: logPath });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const { maxIterations, maxCostUsd, targetCoverage, claudeTimeoutMs, dryRun, workspace } = parsed;
  const memoryDir = join(workspace, '.goalforge', 'memory');

  // ── Contribute path — completely separate flow ─────────────────────────────
  if (parsed.isContribute) {
    await runContribute(workspace, parsed.claudeTimeoutMs);
    process.exit(0);
  }

  // ── Resume path ────────────────────────────────────────────────────────────
  let resumeProjectId: string | undefined;
  let isAutoResumed = false;

  if (parsed.isResume) {
    const saved = loadSavedState(workspace);
    if (!saved) {
      process.stderr.write(
        'Error: nothing to resume — no saved state found in .goalforge/memory/\n' +
        'Run goalforge with a goal first.\n'
      );
      process.exit(1);
    }
    resumeProjectId = saved.projectId;
    const D = '\x1b[2m';
    const R = '\x1b[0m';
    const B = '\x1b[1m';
    process.stdout.write(
      `\n${B}Resuming:${R} ${saved.goal.slice(0, 80)}\n` +
      `${D}  Phase: ${saved.currentPhase}  ·  ` +
      `Iter: ${saved.iterationCount}  ·  ` +
      `Done: ${saved.completedTaskIds.length}  ·  ` +
      `Failed: ${saved.failedTaskIds.length}  ·  ` +
      `Cost: $${saved.totalCostUsd.toFixed(4)}${R}\n\n`
    );
  } else if (parsed.isAutoDiscover) {
    // Before studying the codebase, check whether the previous run left
    // unfinished tasks. If so, pick up from there instead of starting fresh.
    const pending = hasPendingWork(workspace);
    if (pending) {
      resumeProjectId = pending.projectId;
      isAutoResumed = true;
      const D = '\x1b[2m';
      const R = '\x1b[0m';
      const B = '\x1b[1m';
      process.stdout.write(
        `\n${B}Resuming incomplete run:${R} ${pending.goal.slice(0, 80)}\n` +
        `${D}  Phase: ${pending.currentPhase}  ·  ` +
        `Iter: ${pending.iterationCount}  ·  ` +
        `Done: ${pending.completedTaskIds.length}  ·  ` +
        `Failed: ${pending.failedTaskIds.length}  ·  ` +
        `Cost: $${pending.totalCostUsd.toFixed(4)}${R}\n\n`
      );
    }
  }

  ensureGitignore(workspace);

  const session = new InteractiveSession();
  session.attach();

  StatusBar.init(maxIterations);

  let currentGoal = (parsed.isResume || isAutoResumed)
    ? loadSavedState(workspace)!.goal   // already verified above
    : parsed.isAutoDiscover
      ? await discoverGoal(workspace, dryRun)
      : parsed.goal;
  let currentProjectId = resumeProjectId ?? parsed.projectId;
  let attempt = 0;

  while (true) {
    attempt++;

    const isFirstResume = (parsed.isResume || isAutoResumed) && attempt === 1;

    if (attempt > 1) {
      // Clear state between redo attempts (never clear on first resume)
      if (existsSync(memoryDir)) {
        rmSync(memoryDir, { recursive: true, force: true });
      }
      currentProjectId = `project-${Date.now()}`; // fresh ID for redo
      log.info(`GoalForge redo #${attempt - 1}`);
    }

    if (isFirstResume) {
      log.info('Resuming previous run', { projectId: currentProjectId });
    }

    const config = defaultLoopConfig({
      projectId: currentProjectId,
      goal: currentGoal,
      targetCoveragePercent: targetCoverage,
      maxIterations,
      maxCostUsd,
      claudeTimeoutMs,
      workspaceDir: workspace,
      memoryDir,
      dryRun,
    });

    log.info('GoalForge starting', {
      projectId: config.projectId,
      goal: config.goal.slice(0, 80),
      dryRun: config.dryRun,
      maxIterations: config.maxIterations,
      maxCostUsd: config.maxCostUsd,
    });

    const controller = new LoopController(config, session);

    let exit: LoopExitReason;
    try {
      exit = await controller.run();
    } catch (err) {
      log.error('Fatal error', { err: String(err) });
      process.exit(1);
    }

    log.info('GoalForge loop done', {
      reason: exit.reason,
      totalCostUsd: exit.finalState.totalCostUsd.toFixed(4),
      iterations: exit.finalState.iterationCount,
    });

    // User quit from mid-loop prompt
    if (exit.reason === 'user-quit') {
      process.stdout.write('\n[GoalForge] Stopped by user.\n');
      process.exit(0);
    }

    // Mid-loop redo: restart with updated goal already set in config.goal
    if (exit.reason === 'user-redo') {
      currentGoal = config.goal; // may have feedback appended by the controller
      process.stdout.write('\n[GoalForge] Restarting...\n');
      continue;
    }

    // Normal exit: update changelog, clean up memory on success, then ask for finish feedback
    appendToChangelog(workspace, memoryDir, currentGoal);
    if (isSuccessExit(exit.reason)) {
      cleanupAfterSuccess(memoryDir);
    }
    const finish = await session.promptFinish(formatExitSummary(exit));

    if (finish.action === 'quit') {
      process.exit(0);
    }

    if (finish.action === 'continue') {
      // User accepted the result
      process.exit(0);
    }

    // Redo: user wants changes
    const base = parsed.goal; // always start redo from the original goal
    currentGoal = finish.feedback
      ? `${base}\n\n[User direction for redo]: ${finish.feedback}`
      : base;
  }
}

main();
