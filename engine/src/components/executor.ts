import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Task, TaskResult } from '../core/types';
import { CostOptimizer } from './cost-optimizer';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';
import { callClaude } from './claude-cli';

const SYSTEM_PROMPT = `You are a senior software engineer implementing a task as part of an autonomous development loop.
Your output MUST be valid JSON matching this schema (no markdown wrapping):
{
  "explanation": "string — brief rationale for your approach",
  "files": [
    {
      "path": "string — relative to workspace root",
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
- File paths must be relative to the workspace root (no leading slash).
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
    private readonly dryRun = false
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

    let raw: string;
    const cached = this.optimizer.getCachedResponse(cacheKey);
    if (cached) {
      raw = cached;
      this.log.debug('Using cached executor response', { taskId: task.id });
    } else if (this.dryRun) {
      raw = this.dryRunResponse(task);
    } else {
      raw = await this.callApi(task.objective, context);
      this.optimizer.putCachedResponse(cacheKey, raw);
    }

    const parsed = this.parse(raw);
    const result = await this.apply(task, parsed);

    this.memory.updateTaskResult(task.id, result);
    this.log.info('Task executed', {
      taskId: task.id,
      filesCreated: result.filesCreated.length,
      commandsRun: result.commandsRun.length,
    });

    return result;
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

  private async callApi(objective: string, context: string): Promise<string> {
    const { text, costUsd } = await callClaude(
      SYSTEM_PROMPT,
      `TASK: ${objective}\n\nCONTEXT:\n${context}`
    );
    this.optimizer.recordCost(costUsd);
    return text;
  }

  private parse(raw: string): ExecutorResponse {
    const json = raw.replace(/^```json?\n?/m, '').replace(/```$/m, '').trim();
    return JSON.parse(json) as ExecutorResponse;
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

    // Run commands
    for (const cmd of parsed.commands) {
      try {
        this.log.info('Running command', { cmd });
        if (!this.dryRun) {
          execSync(cmd, { cwd: this.workspaceDir, stdio: 'pipe' });
        }
        commandsRun.push(cmd);
      } catch (err) {
        this.log.warn('Command failed (non-fatal)', { cmd, err: String(err) });
        commandsRun.push(`FAILED: ${cmd}`);
      }
    }

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
