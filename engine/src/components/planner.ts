import { randomUUID } from 'crypto';
import { ArchitectureDecision, PlannerOutput, ProjectState } from '../core/types';
import { CostOptimizer } from './cost-optimizer';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';
import { callClaude } from './claude-cli';

const SYSTEM_PROMPT = `You are a senior software architect acting as a project planner.
Your job is to decompose a high-level project goal into a prioritised list of concrete,
independently-executable tasks. Each task must be atomic — a single engineer should be
able to complete it in one sitting.

Return ONLY valid JSON matching this schema (no markdown, no prose):
{
  "tasks": [
    {
      "objective": "string — what exactly must be done",
      "priority": 1,          // integer, 1 = highest
      "dependencies": [],     // array of objective strings from THIS response
      "estimatedEffort": "low|medium|high",
      "rationale": "string — why this task exists"
    }
  ],
  "decisions": [
    {
      "title": "string",
      "context": "string",
      "decision": "string",
      "consequences": "string"
    }
  ]
}`;

interface PlannerResponse {
  tasks: Array<{
    objective: string;
    priority: number;
    dependencies: string[];
    estimatedEffort: 'low' | 'medium' | 'high';
    rationale: string;
  }>;
  decisions: Array<{
    title: string;
    context: string;
    decision: string;
    consequences: string;
  }>;
}

export class Planner {
  private readonly log = createLogger('Planner');

  constructor(
    private readonly optimizer: CostOptimizer,
    private readonly memory: MemoryStore,
    private readonly dryRun = false
  ) {}

  /**
   * Produce an ordered task list for the given goal.
   * Includes prior project state as context so the planner doesn't re-generate
   * already-completed work.
   */
  async plan(goal: string, state: ProjectState): Promise<PlannerOutput[]> {
    const contextSummary = this.buildContext(state);
    const prompt = this.buildPrompt(goal, contextSummary);
    const cacheKey = this.optimizer.buildCacheKey(prompt);
    const estimate = this.optimizer.estimate(prompt, 2000, cacheKey);

    this.log.info('Planning tasks', {
      goal: goal.slice(0, 80),
      action: estimate.recommendedAction,
    });

    if (estimate.recommendedAction === 'skip') {
      this.log.warn('Skipping planning — budget exhausted');
      return [];
    }

    let raw: string;

    const cached = this.optimizer.getCachedResponse(cacheKey);
    if (cached) {
      raw = cached;
    } else if (this.dryRun) {
      raw = this.dryRunResponse(goal);
    } else {
      raw = await this.callApi(prompt);
      this.optimizer.putCachedResponse(cacheKey, raw);
    }

    return this.parse(raw);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private buildContext(state: ProjectState): string {
    const completed = state.completedTaskIds.length;
    const decisions = this.memory.loadAllDecisions();
    const decisionSummary = decisions
      .map((d) => `• ${d.title}: ${d.decision}`)
      .join('\n');

    return [
      `Phase: ${state.currentPhase}`,
      `Iteration: ${state.iterationCount}`,
      `Completed tasks: ${completed}`,
      `Coverage: ${state.coveragePercent}%`,
      decisions.length > 0 ? `\nArchitecture decisions:\n${decisionSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildPrompt(goal: string, context: string): string {
    return [
      `PROJECT GOAL:\n${goal}`,
      `\nCURRENT STATE:\n${context}`,
      '\nGenerate a prioritised task breakdown. Focus only on tasks NOT yet completed.',
      'Be specific and avoid redundancy with already-made architecture decisions.',
    ].join('\n');
  }

  private async callApi(prompt: string): Promise<string> {
    const { text, costUsd } = await callClaude(SYSTEM_PROMPT, prompt);
    this.optimizer.recordCost(costUsd);
    return text;
  }

  private parse(raw: string): PlannerOutput[] {
    let parsed: PlannerResponse;
    try {
      // strip markdown fences if present
      const json = raw.replace(/^```json?\n?/m, '').replace(/```$/m, '').trim();
      parsed = JSON.parse(json);
    } catch (err) {
      this.log.error('Failed to parse planner response', { err: String(err), raw });
      return [];
    }

    // Persist architecture decisions
    for (const d of parsed.decisions ?? []) {
      const decision: ArchitectureDecision = {
        id: randomUUID(),
        ...d,
        madeAt: new Date().toISOString(),
      };
      this.memory.saveDecision(decision);
    }

    // Resolve dependency strings → task objectives (same-batch cross-referencing)
    const tasks = parsed.tasks ?? [];
    const objectiveToIndex = new Map(tasks.map((t, i) => [t.objective, String(i)]));

    return tasks.map((t) => ({
      objective: t.objective,
      priority: t.priority,
      estimatedEffort: t.estimatedEffort,
      rationale: t.rationale,
      dependencies: t.dependencies
        .map((dep) => objectiveToIndex.get(dep))
        .filter((id): id is string => id !== undefined),
    }));
  }

  private dryRunResponse(goal: string): string {
    return JSON.stringify({
      tasks: [
        {
          objective: `[DRY-RUN] Scaffold project structure for: ${goal}`,
          priority: 1,
          dependencies: [],
          estimatedEffort: 'low',
          rationale: 'Dry-run placeholder task',
        },
        {
          objective: `[DRY-RUN] Implement core logic for: ${goal}`,
          priority: 2,
          dependencies: [`[DRY-RUN] Scaffold project structure for: ${goal}`],
          estimatedEffort: 'medium',
          rationale: 'Dry-run placeholder task',
        },
      ],
      decisions: [
        {
          title: 'DRY-RUN mode',
          context: 'Planner invoked with dryRun=true',
          decision: 'Return stubbed tasks without API calls',
          consequences: 'No real planning occurs',
        },
      ],
    });
  }
}
