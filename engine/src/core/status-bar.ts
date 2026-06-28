/**
 * Global sticky-footer status bar with live task panel.
 *
 * Panel rows sit above the separator — one row per active task:
 *   ▶ Create REST API routes…         Here's how I'll structure the routes:
 *   ✓ Write unit tests for auth        Done — wrote 3 file(s)
 *   ────────────────────────── separator ──────────────────────────
 *    ◈ executing   iter 2/20   ✓ 3 done   $0.0041   05m 12s
 *
 * Non-TTY (piped / CI): completely silent.
 */

const IS_TTY = process.stdout.isTTY === true;

const R      = '\x1b[0m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[96m';
const GREEN  = '\x1b[92m';
const RED    = '\x1b[91m';
const YELLOW = '\x1b[93m';

function cols(): number {
  return Math.max(60, process.stdout.columns || 80);
}

// ── Status state ─────────────────────────────────────────────────────────────

export interface StatusState {
  phase: string;
  iteration: number;
  maxIterations: number;
  done: number;
  failed: number;
  costUsd: number;
  activity?: string;
}

const s: StatusState = {
  phase: 'starting',
  iteration: 0,
  maxIterations: 20,
  done: 0,
  failed: 0,
  costUsd: 0,
};

let active = false;
let startedAt = 0;

// ── Task panel ────────────────────────────────────────────────────────────────

interface TaskEntry {
  label: string;
  stream: string;   // rolling tail of streamed text
  done: boolean;
  result: string;   // shown when done
}

const activeTasks = new Map<string, TaskEntry>();

// How many lines were drawn in the last draw() call — needed to erase exactly.
let lastDrawnLines = 2;

// ── Rendering ─────────────────────────────────────────────────────────────────

function elapsed(): string {
  const totalSec = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m.toString().padStart(2, '0')}m ${sec.toString().padStart(2, '0')}s`;
}

function sep(): string {
  return DIM + '─'.repeat(cols()) + R;
}

function statusLine(): string {
  const phase    = `${CYAN}◈${R} ${BOLD}${s.phase.padEnd(12)}${R}`;
  const iter     = `${DIM}iter ${s.iteration}/${s.maxIterations}${R}`;
  const done     = `${GREEN}✓ ${s.done}${R}`;
  const fail     = s.failed > 0 ? `  ${RED}✕ ${s.failed}${R}` : '';
  const cost     = `${YELLOW}$${s.costUsd.toFixed(4)}${R}`;
  const time     = `${DIM}${elapsed()}${R}`;
  const activity = s.activity ? `  ${DIM}${s.activity}${R}` : '';
  return ` ${phase}   ${iter}   ${done}${fail}   ${cost}   ${time}${activity}`;
}

const LABEL_WIDTH = 36;

function taskRow(task: TaskEntry): string {
  const icon  = task.done ? `${GREEN}✓${R}` : `${CYAN}▶${R}`;
  const label = task.done ? `${DIM}${task.label}${R}` : task.label;
  const paddedLabel = task.label.slice(0, LABEL_WIDTH).padEnd(LABEL_WIDTH);
  const rawText = (task.done ? task.result : task.stream)
    .replace(/[\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const maxText = Math.max(0, cols() - LABEL_WIDTH - 8);
  const display = rawText.length > maxText
    ? '…' + rawText.slice(-(maxText - 1))
    : rawText;
  void label; // label variable used for future styling
  return `  ${icon} ${task.done ? DIM : ''}${paddedLabel}${task.done ? R : ''}  ${DIM}${display}${R}`;
}

function draw(): void {
  let out = '';
  for (const [, task] of activeTasks) {
    out += taskRow(task) + '\n';
  }
  out += sep() + '\n' + statusLine() + '\n';
  process.stdout.write(out);
  lastDrawnLines = activeTasks.size + 2;
}

function erase(): void {
  process.stdout.write(`\x1b[${lastDrawnLines}A\x1b[0J`);
}

// ── Public API — status bar ──────────────────────────────────────────────────

export function init(maxIterations: number): void {
  if (!IS_TTY) return;
  s.maxIterations = maxIterations;
  startedAt = Date.now();
  draw();
  active = true;
}

export function update(patch: Partial<StatusState>): void {
  Object.assign(s, patch);
  if (!IS_TTY || !active) return;
  erase();
  draw();
}

/** Wrap a stdout write so the status bar stays at the bottom. */
export function wrapLog(writeFn: () => void): void {
  if (!IS_TTY || !active) {
    writeFn();
    return;
  }
  erase();
  writeFn();
  draw();
}

/** Remove the status bar before an interactive prompt. */
export function suspend(): void {
  if (!IS_TTY || !active) return;
  erase();
  active = false;
}

/** Restore the status bar after an interactive prompt. */
export function resume(): void {
  if (!IS_TTY) return;
  draw();
  active = true;
}

// ── Public API — task panel ───────────────────────────────────────────────────

/** Register a new task slot; immediately appears as a running row. */
export function startTask(id: string, label: string): void {
  activeTasks.set(id, { label, stream: '', done: false, result: '' });
  if (!IS_TTY || !active) return;
  erase();
  draw();
}

/** Append streaming text to a running task's preview. */
export function streamTask(id: string, text: string): void {
  const task = activeTasks.get(id);
  if (!task || task.done) return;
  // Keep a rolling tail so the row shows what Claude is working on right now.
  task.stream = (task.stream + text).slice(-120);
  if (!IS_TTY || !active) return;
  erase();
  draw();
}

/** Mark a task done; its row switches from ▶ to ✓ with the result text. */
export function finishTask(id: string, result: string): void {
  const task = activeTasks.get(id);
  if (!task) return;
  task.done = true;
  task.result = result;
  if (!IS_TTY || !active) return;
  erase();
  draw();
}

/** Remove a single task row (e.g. on error). */
export function clearTask(id: string): void {
  if (!activeTasks.has(id)) return;
  activeTasks.delete(id);
  if (!IS_TTY || !active) return;
  erase();
  draw();
}

/** Remove all task rows — call at phase transitions. */
export function clearAllTasks(): void {
  if (activeTasks.size === 0) return;
  activeTasks.clear();
  if (!IS_TTY || !active) return;
  erase();
  draw();
}
