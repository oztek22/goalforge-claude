import { spawn } from 'child_process';

export interface CliResult {
  text: string;
  costUsd: number;
}

/**
 * Call Claude via the `claude` CLI (uses Claude.ai subscription auth —
 * no ANTHROPIC_API_KEY required).
 *
 * Spawns: claude -p --output-format json --dangerously-skip-permissions
 * Sends the combined system+user prompt via stdin.
 * Returns the result text and reported cost.
 */
export async function callClaude(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 180_000
): Promise<CliResult> {
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout.trim());
        resolve({
          text: envelope.result ?? '',
          costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0,
        });
      } catch (err) {
        reject(new Error(`Failed to parse claude CLI output: ${err}. stdout: ${stdout.slice(0, 300)}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is claude installed and on PATH?`));
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}
