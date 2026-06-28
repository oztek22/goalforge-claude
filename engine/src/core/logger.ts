import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as StatusBar from './status-bar';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// ── Theme ───────────────────────────────────────────────────────────────────

const R    = '\x1b[0m';
const DIM  = '\x1b[2m';
const BOLD = '\x1b[1m';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3,
};

// Per-level prefix shown before the message
const LEVEL_PREFIX: Record<LogLevel, string> = {
  DEBUG: DIM,
  INFO:  '',
  WARN:  '\x1b[93m',   // bright yellow
  ERROR: '\x1b[91m',   // bright red
};

const LEVEL_SUFFIX: Record<LogLevel, string> = {
  DEBUG: R, INFO: R, WARN: R, ERROR: R,
};

interface ComponentStyle {
  icon: string;
  color: string;
}

const COMPONENT_STYLES: Record<string, ComponentStyle> = {
  GoalForge:      { icon: '⬡', color: '\x1b[97m' },   // white
  LoopController: { icon: '◈', color: '\x1b[96m' },   // bright cyan
  Planner:        { icon: '◆', color: '\x1b[95m' },   // bright magenta
  Executor:       { icon: '▶', color: '\x1b[92m' },   // bright green
  Reviewer:       { icon: '●', color: '\x1b[93m' },   // bright yellow
  TestRunner:     { icon: '✓', color: '\x1b[94m' },   // bright blue
  MemoryStore:    { icon: '○', color: DIM          },  // dim
  CostOptimizer:  { icon: '¢', color: '\x1b[33m'  },  // yellow
  TaskQueue:      { icon: '≡', color: DIM          },  // dim
  ClaudeCLI:      { icon: '⟡', color: '\x1b[36m'  },  // cyan
};

const DEFAULT_STYLE: ComponentStyle = { icon: '·', color: DIM };

// Width to which we pad the "icon + name" column
const COMPONENT_COL = 18;

// ── Logger ───────────────────────────────────────────────────────────────────

export class Logger {
  private readonly style: ComponentStyle;

  constructor(
    private readonly component: string,
    private readonly minLevel: LogLevel = 'INFO',
    private readonly logFilePath: string | null = null,
  ) {
    this.style = COMPONENT_STYLES[component] ?? DEFAULT_STYLE;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  private format(level: LogLevel, message: string, meta?: object): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const time = `${DIM}${hh}:${mm}:${ss}${R}`;

    const { icon, color } = this.style;
    const tag = `${color}${BOLD}${icon} ${this.component}${R}`;
    // Pad to a fixed column so messages align
    const rawTag = `${icon} ${this.component}`;
    const pad = Math.max(0, COMPONENT_COL - rawTag.length);

    const levelPfx = LEVEL_PREFIX[level];
    const levelSfx = LEVEL_SUFFIX[level];
    const metaStr = meta ? `  ${DIM}${JSON.stringify(meta)}${R}` : '';

    return `${time}  ${tag}${' '.repeat(pad)}  ${levelPfx}${message}${metaStr}${levelSfx}`;
  }

  private write(level: LogLevel, message: string, meta?: object): void {
    if (!this.shouldLog(level)) return;

    const line = this.format(level, message, meta);

    StatusBar.wrapLog(() => {
      process.stdout.write(line + '\n');
    });

    if (this.logFilePath) {
      try {
        const ts = new Date().toISOString();
        const plain = `[${ts}] [${level}] [${this.component}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
        appendFileSync(this.logFilePath, plain + '\n');
      } catch { /* ignore */ }
    }
  }

  debug(message: string, meta?: object): void { this.write('DEBUG', message, meta); }
  info(message: string, meta?: object): void  { this.write('INFO',  message, meta); }
  warn(message: string, meta?: object): void  { this.write('WARN',  message, meta); }
  error(message: string, meta?: object): void { this.write('ERROR', message, meta); }
}

export function createLogger(component: string, logDir?: string): Logger {
  const level = (process.env.LOG_LEVEL as LogLevel) ?? 'INFO';
  let logFilePath: string | null = null;
  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    logFilePath = join(logDir, 'goalforge.log');
  }
  return new Logger(component, level, logFilePath);
}
