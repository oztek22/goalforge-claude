import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Task, TaskResult } from '../core/types';
import { CostOptimizer } from './cost-optimizer';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';
import { callClaude } from './claude-cli';
import * as StatusBar from '../core/status-bar';

const SYSTEM_PROMPT = `You are a senior software engineer implementing a task as part of an autonomous development loop.
Your output MUST be valid JSON matching this schema (no markdown wrapping):
{
  "explanation": "string — brief rationale for your approach",
  "files": [
    {
      "path": "string — relative to the project root (e.g. src/index.ts, package.json)",
      "content": "string — full file content"
    }
  ],
  "commands": [
    "string — shell commands to run after files are written (e.g. npm install)"
  ],
  "summary": "string — one sentence describing what was done"
}

Rules:
- Produce real, working code — no stubs or TODOs unless the task explicitly says so.
- File paths must be relative to the project root — no leading slash, no workspace/ prefix.
- Keep commands minimal and safe (no destructive operations).
- If no commands are needed, return an empty array.`;

interface ExecutorResponse {
  explanation: string;
  files: Array<{ path: string; content: string }>;
  commands: string[];
  summary: string;
}

export class Executor {
  private readonly log = createLogger('Executor');

  constructor(
    private readonly workspaceDir: string,
    private readonly optimizer: CostOptimizer,
    private readonly memory: MemoryStore,
    private readonly dryRun = false,
    private readonly timeoutMs = 600_000,
    private readonly model = ''
  ) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  async execute(task: Task): Promise<TaskResult> {
    this.log.info('Executing task', { taskId: task.id, objective: task.objective });

    const context = this.buildContext(task);
    const cacheKey = this.optimizer.buildCacheKey(task.objective, context);
    const estimate = this.optimizer.estimate(
      task.objective + context,
      4000,
      cacheKey
    );

    if (estimate.recommendedAction === 'skip') {
      throw new Error('Budget exhausted — cannot execute task');
    }

    StatusBar.startTask(task.id, task.objective.slice(0, 36));
    let raw: string;
    try {
      const cached = this.optimizer.getCachedResponse(cacheKey);
      if (cached) {
        raw = cached;
        this.log.debug('Using cached executor response', { taskId: task.id });
      } else if (this.dryRun) {
        raw = this.dryRunResponse(task);
      } else {
        raw = await this.callApi(task.id, task.objective, context);
        this.optimizer.putCachedResponse(cacheKey, raw);
      }

      const parsed = this.parse(raw);
      const result = await this.apply(task, parsed);

      const fileSummary = result.filesCreated.length > 0
        ? `wrote ${result.filesCreated.length} file(s)`
        : 'no files written';
      StatusBar.finishTask(task.id, fileSummary);

      this.memory.updateTaskResult(task.id, result);
      this.log.info('Task executed', {
        taskId: task.id,
        filesCreated: result.filesCreated.length,
        commandsRun: result.commandsRun.length,
      });

      return result;
    } catch (err) {
      StatusBar.clearTask(task.id);
      throw err;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private buildContext(task: Task): string {
    const decisions = this.memory
      .loadAllDecisions()
      .map((d) => `• ${d.title}: ${d.decision}`)
      .join('\n');

    const completedTasks = this.memory
      .loadAllTasks()
      .filter((t) => t.status === 'COMPLETE' && t.result)
      .slice(-5) // last 5 for brevity
      .map((t) => `• ${t.objective}: ${t.result!.output.slice(0, 200)}`)
      .join('\n');

    return [
      `Task objective: ${task.objective}`,
      `Effort: ${task.estimatedEffort}`,
      decisions ? `\nArchitecture decisions:\n${decisions}` : '',
      completedTasks ? `\nRecent completed work:\n${completedTasks}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async callApi(taskId: string, objective: string, context: string): Promise<string> {
    const { text, costUsd } = await callClaude(
      SYSTEM_PROMPT,
      `TASK: ${objective}\n\nCONTEXT:\n${context}`,
      this.timeoutMs,
      taskId,
      this.model
    );
    this.optimizer.recordCost(costUsd);
    return text;
  }

  private parse(raw: string): ExecutorResponse {
    // Strategy 1: strip markdown fences and parse directly
    const stripped = raw.replace(/^```json?\n?/m, '').replace(/```$/m, '').trim();
    try {
      return JSON.parse(stripped) as ExecutorResponse;
    } catch { /* fall through */ }

    // Strategy 2: extract the outermost JSON object from the text
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stripped.slice(firstBrace, lastBrace + 1)) as ExecutorResponse;
      } catch { /* fall through */ }
    }

    throw new Error(`Executor: response is not valid JSON. Raw (first 500 chars): ${raw.slice(0, 500)}`);
  }

  private async apply(task: Task, parsed: ExecutorResponse): Promise<TaskResult> {
    const filesCreated: string[] = [];
    const commandsRun: string[] = [];

    // Write files
    for (const file of parsed.files) {
      const absPath = join(this.workspaceDir, file.path);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, file.content, 'utf-8');
      filesCreated.push(absPath);
      this.memory.recordGeneratedFile(absPath, task.id, file.content);
      this.log.debug('File written', { path: absPath });
    }

    // Run commands — inherit stdio so output is visible to the user
    for (const cmd of parsed.commands) {
      this.log.info(`Running: ${cmd}`);
      try {
        if (!this.dryRun) {
          execSync(cmd, { cwd: this.workspaceDir, stdio: 'inherit' });
        }
        commandsRun.push(cmd);
      } catch (err) {
        this.log.warn('Command failed (non-fatal)', { cmd, err: String(err) });
        commandsRun.push(`FAILED: ${cmd}`);
      }
    }

    this.log.info(`Done — ${parsed.summary}`);

    return {
      output: parsed.summary,
      filesCreated,
      filesModified: [],
      commandsRun,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: this.optimizer.getStats().totalSpendUsd,
      },
      executedAt: new Date().toISOString(),
    };
  }

  // ── Repair ─────────────────────────────────────────────────────────────────

  /**
   * Analyse why a task failed and return a revised objective.
   * Called before retry so the next attempt has a better goal.
   */
  async repair(task: Task, error: string): Promise<{ rootCause: string; revisedObjective: string | null }> {
    if (this.dryRun) {
      return { rootCause: '[dry-run] skipped repair', revisedObjective: null };
    }

    const cacheKey = this.optimizer.buildCacheKey('repair', task.id, error.slice(0, 200));
    const cached = this.optimizer.getCachedResponse(cacheKey);

    const repairId = `${task.id}:repair`;
    let raw: string;
    if (cached) {
      raw = cached;
    } else {
      StatusBar.startTask(repairId, `Diagnosing: ${task.objective.slice(0, 30)}…`);
      const { text, costUsd } = await callClaude(
        `You are a senior engineer debugging a failed automated development task.
Diagnose the failure and propose a fix.

Return ONLY valid JSON (no markdown):
{
  "rootCause": "one sentence — why it failed",
  "revisedObjective": "rewritten task that avoids the root cause, or null if unrecoverable"
}`,
        `TASK: ${task.objective}\nEFFORT: ${task.estimatedEffort}\n\nERROR:\n${error.slice(0, 600)}`,
        this.timeoutMs,
        repairId,
        this.model
      );
      StatusBar.clearTask(repairId);
      this.optimizer.recordCost(costUsd);
      this.optimizer.putCachedResponse(cacheKey, text);
      raw = text;
    }

    try {
      const stripped = raw.replace(/^```json?\n?/m, '').replace(/```$/m, '').trim();
      const first = stripped.indexOf('{');
      const last  = stripped.lastIndexOf('}');
      const parsed = JSON.parse(first !== -1 && last > first ? stripped.slice(first, last + 1) : stripped);
      return {
        rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : error.slice(0, 120),
        revisedObjective: typeof parsed.revisedObjective === 'string' ? parsed.revisedObjective : null,
      };
    } catch {
      return { rootCause: error.slice(0, 120), revisedObjective: null };
    }
  }

  private dryRunResponse(task: Task): string {
    return JSON.stringify({
      explanation: 'Dry-run — no API call made',
      files: [
        {
          path: `dry-run/${task.id}.txt`,
          content: `Dry-run output for task: ${task.objective}\n`,
        },
      ],
      commands: [],
      summary: `[DRY-RUN] Completed: ${task.objective}`,
    } satisfies ExecutorResponse);
  }
}
