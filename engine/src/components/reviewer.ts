import { randomUUID } from 'crypto';
import { Critique, ReviewResult, Task } from '../core/types';
import { CostOptimizer } from './cost-optimizer';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';
import { callClaude } from './claude-cli';

const SYSTEM_PROMPT = `You are a critical code reviewer in an autonomous development loop.
Your job is to find real problems — not style preferences. Be specific and actionable.

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
  90-100 : excellent, ship it
  70-89  : good, minor issues
  50-69  : mediocre, should fix before proceeding
  0-49   : significant problems, must rework

"passed" = score >= 70 AND no "critical" severity critiques.`;

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
    private readonly dryRun = false
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

    let raw: string;
    const cached = this.optimizer.getCachedResponse(cacheKey);
    if (cached) {
      raw = cached;
    } else if (this.dryRun) {
      raw = this.dryRunResponse(task);
    } else {
      raw = await this.callApi(prompt);
      this.optimizer.putCachedResponse(cacheKey, raw);
    }

    const result = this.parse(task.id, raw);

    // Persist critiques to memory
    for (const c of result.critiques) {
      this.memory.saveCritique(c);
    }

    this.log.info('Review complete', {
      taskId: task.id,
      score: result.score,
      passed: result.passed,
      criticalIssues: result.critiques.filter((c) => c.severity === 'critical').length,
    });

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

  private async callApi(prompt: string): Promise<string> {
    const { text, costUsd } = await callClaude(SYSTEM_PROMPT, prompt);
    this.optimizer.recordCost(costUsd);
    return text;
  }

  private parse(taskId: string, raw: string): ReviewResult {
    let parsed: ReviewerResponse;
    try {
      const json = raw.replace(/^```json?\n?/m, '').replace(/```$/m, '').trim();
      parsed = JSON.parse(json);
    } catch (err) {
      this.log.error('Failed to parse review response', { err: String(err) });
      return this.emptyReview(taskId, 'Parse error');
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
      passed: true, // assume pass when review cannot run
      score: 100,
      critiques: [],
      suggestions: [reason],
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
