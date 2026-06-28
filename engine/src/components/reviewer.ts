import { randomUUID } from 'crypto';
import { Critique, ReviewResult, Task } from '../core/types';
import { CostOptimizer } from './cost-optimizer';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';
import { callClaude } from './claude-cli';
import * as StatusBar from '../core/status-bar';

const SYSTEM_PROMPT = `You are an adversarial code reviewer in an autonomous development loop.
Your DEFAULT verdict is REJECT (passed=false). Only set passed=true when there is clear,
positive evidence that the task is correctly and completely implemented.

Find real problems — not style preferences. Be specific and actionable. Verify the artifact,
not the intent: does it actually work, not just look right?

Return ONLY valid JSON (no markdown):
{
  "score": 0-100,
  "passed": true|false,
  "critiques": [
    {
      "severity": "low|medium|high|critical",
      "category": "missing-feature|complexity|correctness|performance|security",
      "description": "what is wrong",
      "suggestion": "how to fix it specifically"
    }
  ],
  "suggestions": ["string — broader improvement ideas"]
}

Score guide:
  90-100 : correct and complete — set passed=true
  70-89  : mostly correct, minor gaps — set passed=true only if no blocking issues
  50-69  : mediocre, should fix — passed=false
  0-49   : significant problems — passed=false

Rules:
- If the task objective mentions creating a file and no file was created: score <= 30, passed=false
- If tests fail or coverage regresses: score <= 40, passed=false
- If critical issues exist: passed=false regardless of score
- When in doubt, REJECT — a false rejection is safer than a false pass`;

interface RawCritique {
  severity: Critique['severity'];
  category: Critique['category'];
  description: string;
  suggestion: string;
}

interface ReviewerResponse {
  score: number;
  passed: boolean;
  critiques: RawCritique[];
  suggestions: string[];
}

export class Reviewer {
  private readonly log = createLogger('Reviewer');

  constructor(
    private readonly optimizer: CostOptimizer,
    private readonly memory: MemoryStore,
    private readonly dryRun = false,
    private readonly timeoutMs = 600_000
  ) {}

  async review(task: Task): Promise<ReviewResult> {
    this.log.info('Reviewing task', { taskId: task.id });

    if (!task.result) {
      this.log.warn('Task has no result to review', { taskId: task.id });
      return this.emptyReview(task.id, 'No result to review');
    }

    const prompt = this.buildPrompt(task);
    const cacheKey = this.optimizer.buildCacheKey('review', task.id, prompt);
    const estimate = this.optimizer.estimate(prompt, 1500, cacheKey);

    if (estimate.recommendedAction === 'skip') {
      this.log.warn('Skipping review — budget exhausted');
      return this.emptyReview(task.id, 'Budget exhausted');
    }

    const reviewId = `${task.id}:review`;
    StatusBar.startTask(reviewId, `Review: ${task.objective.slice(0, 30)}`);
    let raw: string;
    try {
      const cached = this.optimizer.getCachedResponse(cacheKey);
      if (cached) {
        raw = cached;
      } else if (this.dryRun) {
        raw = this.dryRunResponse(task);
      } else {
        raw = await this.callApi(reviewId, prompt, task.objective);
        this.optimizer.putCachedResponse(cacheKey, raw);
      }
    } catch (err) {
      StatusBar.clearTask(reviewId);
      throw err;
    }

    const result = this.parse(task.id, raw);

    // Persist critiques to memory
    for (const c of result.critiques) {
      this.memory.saveCritique(c);
    }

    const critical = result.critiques.filter((c) => c.severity === 'critical').length;
    const verdict = result.passed ? '✓ passed' : '✗ failed';
    StatusBar.finishTask(reviewId, `${verdict}  ${result.score}/100`);
    this.log.info(`Review ${verdict} — score ${result.score}/100${critical > 0 ? `  (${critical} critical)` : ''}`);
    if (!result.passed) {
      result.critiques.slice(0, 3).forEach(c =>
        this.log.warn(`  [${c.severity}] ${c.description}`)
      );
    }

    return result;
  }

  /** Count critical issues across all stored critiques. */
  countCriticalIssues(): number {
    return this.memory
      .loadAllCritiques()
      .filter((c) => c.severity === 'critical').length;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private buildPrompt(task: Task): string {
    const priorCritiques = this.memory
      .loadCritiquesForTask(task.id)
      .map((c) => `• [${c.severity}] ${c.description}`)
      .join('\n');

    const filesCreated = task.result!.filesCreated
      .map((f) => `• ${f}`)
      .join('\n');

    return [
      `TASK: ${task.objective}`,
      `\nOUTPUT SUMMARY:\n${task.result!.output}`,
      filesCreated ? `\nFILES CREATED:\n${filesCreated}` : '',
      priorCritiques ? `\nPRIOR CRITIQUES (avoid duplicates):\n${priorCritiques}` : '',
      '\nAnalyse this work. Find real problems only — not stylistic preferences.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async callApi(taskId: string, prompt: string, _taskObjective: string): Promise<string> {
    const { text, costUsd } = await callClaude(SYSTEM_PROMPT, prompt, this.timeoutMs, taskId);
    this.optimizer.recordCost(costUsd);
    return text;
  }

  private parse(taskId: string, raw: string): ReviewResult {
    let parsed: ReviewerResponse;
    try {
      const stripped = raw.replace(/^```json?\n?/m, '').replace(/```$/m, '').trim();
      try {
        parsed = JSON.parse(stripped);
      } catch {
        const first = stripped.indexOf('{');
        const last = stripped.lastIndexOf('}');
        if (first !== -1 && last > first) {
          parsed = JSON.parse(stripped.slice(first, last + 1));
        } else {
          throw new Error('No JSON object found');
        }
      }
    } catch (err) {
      this.log.error('Failed to parse review response — defaulting to REJECT', { err: String(err) });
      return this.failedReview(taskId, 'Review parse error — cannot verify task output');
    }

    const critiques: Critique[] = (parsed.critiques ?? []).map((c) => ({
      id: randomUUID(),
      taskId,
      severity: c.severity,
      category: c.category,
      description: c.description,
      suggestion: c.suggestion,
      createdAt: new Date().toISOString(),
    }));

    return {
      taskId,
      passed: parsed.passed ?? parsed.score >= 70,
      score: parsed.score,
      critiques,
      suggestions: parsed.suggestions ?? [],
      reviewedAt: new Date().toISOString(),
    };
  }

  private emptyReview(taskId: string, reason: string): ReviewResult {
    return {
      taskId,
      passed: true, // assume pass only for operational skips (budget, no result)
      score: 100,
      critiques: [],
      suggestions: [reason],
      reviewedAt: new Date().toISOString(),
    };
  }

  private failedReview(taskId: string, reason: string): ReviewResult {
    return {
      taskId,
      passed: false,
      score: 0,
      critiques: [{
        id: `${taskId}:parse-error`,
        taskId,
        severity: 'high',
        category: 'correctness',
        description: reason,
        suggestion: 'Re-run the task so the reviewer can verify its output',
        createdAt: new Date().toISOString(),
      }],
      suggestions: [],
      reviewedAt: new Date().toISOString(),
    };
  }

  private dryRunResponse(task: Task): string {
    return JSON.stringify({
      score: 85,
      passed: true,
      critiques: [
        {
          severity: 'low',
          category: 'missing-feature',
          description: '[DRY-RUN] Placeholder critique',
          suggestion: 'This is a dry-run — no real review performed',
        },
      ],
      suggestions: ['Dry-run mode active — enable real review for production use'],
    } satisfies ReviewerResponse);
  }
}
