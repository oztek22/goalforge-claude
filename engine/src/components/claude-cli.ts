import { spawn } from 'child_process';
import { createLogger } from '../core/logger';
import * as StatusBar from '../core/status-bar';

const log = createLogger('ClaudeCLI');

export interface CliResult {
  text: string;
  costUsd: number;
}

/** Thrown when the Claude CLI reports a rate/usage limit. Loop can sleep and retry. */
export class RateLimitError extends Error {
  constructor(public readonly resetDelayMs: number) {
    super(`Rate limit hit — resets in ${Math.ceil(resetDelayMs / 60_000)}m`);
    this.name = 'RateLimitError';
  }
}

const RATE_LIMIT_PATTERN =
  /\b(session|usage|rate)\s+limit\b|hit your (session|usage) limit|reached your usage|limit reached|too many requests/i;

function parseResetDelayMs(text: string): number {
  const match = text.match(/reset[^.]*?(?:at|@)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (match) {
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2] ?? '0', 10);
    const isPm = match[3].toLowerCase() === 'pm';
    const resetHour = isPm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
    const now = new Date();
    const reset = new Date(now);
    reset.setHours(resetHour, minute, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return Math.max(60_000, reset.getTime() - now.getTime());
  }
  return 30 * 60_000; // default: 30 minutes
}

// Max chars of Claude's streaming response to echo to the terminal.
const STREAM_PREVIEW_LIMIT = 500;

const DIM  = '\x1b[2m';
const R    = '\x1b[0m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

const SYS_PREVIEW_CHARS  = 120;
const USER_PREVIEW_CHARS = 400;

function logPromptToTUI(systemPrompt: string, userPrompt: string, taskId?: string): void {
  const label   = taskId ? ` ${DIM}[${taskId}]${R}` : '';
  const sysLine = systemPrompt.slice(0, SYS_PREVIEW_CHARS).replace(/\n/g, ' ').trim()
    + (systemPrompt.length > SYS_PREVIEW_CHARS ? '…' : '');
  const userLine = userPrompt.slice(0, USER_PREVIEW_CHARS).replace(/\n/g, '↵').trim()
    + (userPrompt.length > USER_PREVIEW_CHARS ? '…' : '');

  StatusBar.wrapLog(() => {
    process.stdout.write(
      `${CYAN}${BOLD}⟡ Claude prompt${R}${label}\n`
      + `  ${DIM}sys: ${sysLine}${R}\n`
      + `  ${DIM}usr: ${userLine}${R}\n`
    );
  });
}

/**
 * Call Claude via the `claude` CLI (uses Claude.ai subscription auth —
 * no ANTHROPIC_API_KEY required).
 *
 * Spawns: claude -p --output-format stream-json --dangerously-skip-permissions
 * Streams NDJSON events so the user sees Claude's response as it generates.
 * Returns the result text and reported cost from the final `result` event.
 */
export async function callClaude(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 600_000),
  taskId?: string   // when set, streaming goes to the task panel instead of stdout
): Promise<CliResult> {
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const debug = process.env.GOALFORGE_DEBUG === 'true';

  // Always log prompts to TUI so the user can see what is being sent to Claude.
  logPromptToTUI(systemPrompt, userPrompt, taskId);

  if (debug) {
    log.debug('Claude call starting', {
      promptChars: fullPrompt.length,
      timeoutMs,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Track streaming state
    let lastTextLength = 0;   // for cumulative assistant events (delta = text.slice(lastTextLength))
    let shownChars = 0;
    let streamStarted = false;
    let resultEvent: Record<string, unknown> | null = null;
    let stderr = '';
    let lineBuffer = '';
    let rateLimitDetected = false;
    let rateLimitResetMs = 0;

    // Heartbeat: redraw status bar every 5 s so the elapsed timer stays live.
    const heartbeat = setInterval(() => StatusBar.update({}), 5_000);

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // non-JSON line (rare); ignore
      }

      if (event.type === 'assistant') {
        const msg = event.message as Record<string, unknown> | undefined;
        const content = (msg?.content ?? []) as Array<{ type: string; text?: string }>;

        for (const block of content) {
          if (block.type !== 'text' || !block.text) continue;

          const newChars = block.text.length > lastTextLength
            ? block.text.slice(lastTextLength)   // cumulative mode
            : block.text;                         // incremental mode
          lastTextLength = Math.max(lastTextLength, block.text.length);

          if (!newChars) continue;

          if (taskId) {
            // Route to task panel row — no char limit, panel truncates visually.
            StatusBar.streamTask(taskId, newChars);
          } else {
            // Legacy: stream directly to stdout up to STREAM_PREVIEW_LIMIT.
            if (shownChars >= STREAM_PREVIEW_LIMIT) continue;
            const toShow = newChars.slice(0, STREAM_PREVIEW_LIMIT - shownChars);
            if (!toShow) continue;
            if (!streamStarted) {
              streamStarted = true;
              StatusBar.wrapLog(() => process.stdout.write('\n'));
            }
            StatusBar.wrapLog(() => process.stdout.write(toShow));
            shownChars += toShow.length;
            if (shownChars >= STREAM_PREVIEW_LIMIT) {
              StatusBar.wrapLog(() => process.stdout.write('…\n'));
            }
          }
        }
      } else if (event.type === 'rate_limit_event') {
        rateLimitDetected = true;
        const info = event.rate_limit_info as Record<string, unknown> | undefined;
        if (typeof info?.resets_at === 'number') {
          rateLimitResetMs = Math.max(0, (info.resets_at as number) * 1000 - Date.now());
        }
      } else if (event.type === 'result') {
        resultEvent = event;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      lines.forEach(processLine);
    });

    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);

      // Flush any remaining partial line
      if (lineBuffer.trim()) processLine(lineBuffer);

      // Ensure direct-stdout streaming ends on a clean line (task panel handles its own layout).
      if (!taskId && streamStarted && shownChars < STREAM_PREVIEW_LIMIT) {
        StatusBar.wrapLog(() => process.stdout.write('\n'));
      }

      if (debug) {
        log.debug('Claude call finished', {
          exitCode: code,
          resultChars: typeof resultEvent?.result === 'string' ? (resultEvent.result as string).length : 0,
          costUsd: resultEvent?.total_cost_usd,
        });
      }

      // Use the result event as the authoritative source of truth.
      const res = resultEvent;

      // Rate limit: structured event OR text pattern in stderr/result
      const combinedOutput = stderr + (typeof resultEvent?.result === 'string' ? resultEvent.result : '');
      if (rateLimitDetected || RATE_LIMIT_PATTERN.test(combinedOutput)) {
        const delay = rateLimitResetMs || parseResetDelayMs(combinedOutput);
        reject(new RateLimitError(delay));
        return;
      }

      if (code !== 0) {
        const message = (typeof res?.result === 'string' && res.result.trim())
          ? res.result.trim()
          : (stderr.trim() || '(no output captured)');
        reject(new Error(`claude exited ${code}: ${message.slice(0, 500)}`));
        return;
      }

      if (!res) {
        reject(new Error(`claude produced no result event. stderr: ${stderr.slice(0, 300)}`));
        return;
      }

      if (res.is_error === true) {
        const msg = typeof res.result === 'string' ? res.result.trim() : 'unknown error';
        reject(new Error(`claude returned an error: ${msg}`));
        return;
      }

      const costUsd = typeof res.total_cost_usd === 'number' ? res.total_cost_usd : 0;
      if (typeof res.total_cost_usd !== 'number') {
        log.warn('total_cost_usd missing — cost tracking may be inaccurate (subscription billing)');
      }

      resolve({
        text: typeof res.result === 'string' ? res.result : '',
        costUsd,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is claude installed and on PATH?`));
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}
