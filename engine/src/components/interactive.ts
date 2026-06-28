import * as readline from 'readline';
import * as StatusBar from '../core/status-bar';

export type FeedbackAction = 'continue' | 'redo' | 'quit';

export interface FeedbackResult {
  action: FeedbackAction;
  feedback: string;
}

const W = 54; // banner width

function banner(title: string): string {
  const pad = Math.max(0, W - 2 - title.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return [
    '\n╔' + '═'.repeat(W) + '╗',
    '║' + ' '.repeat(left) + title + ' '.repeat(right) + '║',
    '╚' + '═'.repeat(W) + '╝\n',
  ].join('\n');
}

/**
 * Manages interactive mid-loop and post-loop feedback.
 *
 * Call attach() once at startup. The loop controller calls reportPhase()
 * at the start of each phase so the banner shows the right context.
 * isPaused() is checked between tasks inside phases (for quick response)
 * and again at end-of-iteration as a safety net.
 */
export class InteractiveSession {
  private paused = false;
  private lastPhase = 'unknown';

  attach(): void {
    process.on('SIGINT', () => {
      if (this.paused) {
        process.stdout.write('\n[GoalForge] Force quit.\n');
        process.exit(130);
      }
      process.stdout.write(
        banner(`⏸  Paused during: ${this.lastPhase}`) +
        '  Finishing current AI call — standby for the prompt.\n' +
        '  (Press Ctrl+C again to force quit.)\n'
      );
      this.paused = true;
    });
  }

  /** Called at the start of each phase so the banner shows accurate context. */
  reportPhase(phase: string): void {
    this.lastPhase = phase;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Show the mid-loop feedback prompt after a pause.
   */
  async promptMidLoop(phase: string, iterationCount: number): Promise<FeedbackResult> {
    this.paused = false;
    StatusBar.suspend();

    process.stdout.write(
      banner(`⏸  GoalForge paused  ·  ${phase}  ·  iter ${iterationCount}`) +
      '  Enter             → continue as-is\n' +
      '  <your feedback>   → inject feedback and continue\n' +
      '  redo              → restart from scratch (same goal)\n' +
      '  redo <feedback>   → restart with extra direction\n' +
      '  quit  /  q        → stop\n\n'
    );

    const result = await this.ask('> ');
    StatusBar.resume();
    return result;
  }

  /**
   * Show the finish prompt after the loop exits normally.
   */
  async promptFinish(summary: string): Promise<FeedbackResult> {
    StatusBar.suspend();

    process.stdout.write(
      banner('✓  GoalForge finished') +
      summary + '\n' +
      '\n' +
      '  Enter / y         → accept and exit\n' +
      '  <your feedback>   → redo from scratch with your direction\n' +
      '  quit  /  q        → exit without redoing\n\n'
    );

    const result = await this.ask('> ');
    StatusBar.suspend(); // keep it gone — we're done or redoing
    return result;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private ask(prompt: string): Promise<FeedbackResult> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      const sigintHandler = () => { rl.close(); process.exit(130); };
      process.once('SIGINT', sigintHandler);

      rl.question(prompt, (answer) => {
        process.removeListener('SIGINT', sigintHandler);
        rl.close();
        resolve(this.parseAnswer(answer.trim()));
      });
    });
  }

  private parseAnswer(input: string): FeedbackResult {
    const lower = input.toLowerCase();

    if (!input || lower === 'y' || lower === 'yes' || lower === 'continue' || lower === 'c') {
      return { action: 'continue', feedback: '' };
    }
    if (lower === 'quit' || lower === 'q' || lower === 'exit') {
      return { action: 'quit', feedback: '' };
    }
    if (lower === 'n' || lower === 'no') {
      return { action: 'redo', feedback: '' };
    }
    if (lower.startsWith('redo')) {
      return { action: 'redo', feedback: input.slice(4).trim() };
    }
    // Free-form → treat as feedback to inject, then continue
    return { action: 'continue', feedback: input };
  }
}
