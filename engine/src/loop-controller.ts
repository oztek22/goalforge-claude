import { LoopConfig, LoopExitReason, ProjectState, TestReport } from './core/types';
import { DEFAULT_BUDGET } from './core/config';
import { createLogger } from './core/logger';
import { MemoryStore } from './components/memory-store';
import { TaskQueue } from './components/task-queue';
import { CostOptimizer } from './components/cost-optimizer';
import { Planner } from './components/planner';
import { Executor } from './components/executor';
import { Reviewer } from './components/reviewer';
import { TestRunner } from './components/test-runner';

/**
 * LoopController is the autonomous development loop.
 *
 * while (project_not_complete) {
 *   planner()       → produce tasks
 *   executor()      → implement tasks
 *   testRunner()    → validate coverage
 *   reviewer()      → critique output
 *   costOptimizer() → check budget
 *   updateMemory()  → persist state
 * }
 */
export class LoopController {
  private readonly log = createLogger('LoopController');
  private readonly memory: MemoryStore;
  private readonly queue: TaskQueue;
  private readonly optimizer: CostOptimizer;
  private readonly planner: Planner;
  private readonly executor: Executor;
  private readonly reviewer: Reviewer;
  private readonly testRunner: TestRunner;
  private state: ProjectState;

  constructor(private readonly config: LoopConfig) {
    this.memory = new MemoryStore(config.memoryDir);
    this.queue = new TaskQueue(this.memory);
    this.optimizer = new CostOptimizer(DEFAULT_BUDGET, this.memory);
    this.planner = new Planner(this.optimizer, this.memory, config.dryRun);
    this.executor = new Executor(
      config.workspaceDir,
      this.optimizer,
      this.memory,
      config.dryRun
    );
    this.reviewer = new Reviewer(this.optimizer, this.memory, config.dryRun);
    this.testRunner = new TestRunner(config.workspaceDir);
    this.state = {
      projectId: config.projectId,
      goal: config.goal,
      currentPhase: 'init',
      iterationCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      coveragePercent: 0,
      testsPassing: false,
      criticalIssueCount: 0,
      completedTaskIds: [],
      failedTaskIds: [],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async run(): Promise<LoopExitReason> {
    this.log.info('=== AUTONOMOUS LOOP STARTING ===', {
      projectId: this.config.projectId,
      goal: this.config.goal.slice(0, 80),
      dryRun: this.config.dryRun,
    });

    this.state = this.initState();
    this.persistState();

    let iteration = 0;

    while (iteration < this.config.maxIterations) {
      iteration++;
      this.state.iterationCount = iteration;

      this.log.info(`\n── Iteration ${iteration} ──────────────────────────────────`);

      // ── 1. Plan ────────────────────────────────────────────────────────────
      const exitAfterPlan = await this.planPhase();
      if (exitAfterPlan) return exitAfterPlan;

      // ── 2. Execute ─────────────────────────────────────────────────────────
      const exitAfterExec = await this.executePhase();
      if (exitAfterExec) return exitAfterExec;

      // ── 3. Test ────────────────────────────────────────────────────────────
      const testReport = await this.testPhase();

      // ── 4. Review ──────────────────────────────────────────────────────────
      await this.reviewPhase();

      // ── 5. Cost check ──────────────────────────────────────────────────────
      const exitAfterCost = this.costCheckPhase();
      if (exitAfterCost) return exitAfterCost;

      // ── 6. Update memory / check exit conditions ───────────────────────────
      this.updateMemoryPhase(testReport);
      const exitCondition = this.checkExitConditions();
      if (exitCondition) return exitCondition;
    }

    return this.buildExit(
      'max-iterations',
      `Reached max iteration limit of ${this.config.maxIterations}`
    );
  }

  getState(): ProjectState {
    return { ...this.state };
  }

  // ── Phases ─────────────────────────────────────────────────────────────────

  private async planPhase(): Promise<LoopExitReason | null> {
    this.state.currentPhase = 'planning';

    if (this.queue.nextEligible() !== null) {
      this.log.debug('Eligible tasks already in queue — skipping re-planning');
      return null;
    }

    this.log.info('Phase: PLAN');

    try {
      const plans = await this.planner.plan(this.config.goal, this.state);

      if (plans.length === 0) {
        this.log.info('Planner returned no tasks');
        if (this.queue.isComplete()) {
          return this.buildExit('all-tasks-complete', 'All tasks complete and planner produced nothing new');
        }
        return null;
      }

      this.queue.enqueueBatch(plans);
      this.log.info('Tasks enqueued', { count: plans.length });
    } catch (err) {
      this.log.error('Planner failed', { err: String(err) });
    }

    return null;
  }

  private async executePhase(): Promise<LoopExitReason | null> {
    this.state.currentPhase = 'executing';

    let task = this.queue.nextEligible();
    if (!task) {
      this.log.warn('No eligible tasks to execute');
      return null;
    }

    this.log.info('Phase: EXECUTE', {
      queueStats: this.queue.stats(),
    });

    // Execute up to 3 tasks per iteration to allow interleaved review/test cycles
    let executed = 0;
    while (task && executed < 3) {
      if (this.optimizer.isBudgetExceeded()) {
        return this.buildExit('cost-exceeded', 'Budget exceeded during execution');
      }

      this.log.info('Starting task', { taskId: task.id, objective: task.objective });
      this.queue.start(task.id);

      try {
        const result = await this.executor.execute(task);
        task = this.queue.update(task.id, { result });
        this.queue.complete(task.id);
        this.state.completedTaskIds.push(task.id);
        this.log.info('Task complete', { taskId: task.id, output: result.output });
      } catch (err) {
        this.log.error('Execution failed', { taskId: task.id, err: String(err) });
        this.queue.fail(task.id, String(err));
        this.state.failedTaskIds.push(task.id);
      }

      executed++;
      task = this.queue.nextEligible();
    }

    return null;
  }

  private async testPhase(): Promise<TestReport> {
    this.state.currentPhase = 'testing';
    this.log.info('Phase: TEST');

    const report = await this.testRunner.run();
    this.state.coveragePercent = report.coveragePercent;
    this.state.testsPassing = report.failed === 0;

    this.log.info('Test report', {
      total: report.totalTests,
      passed: report.passed,
      failed: report.failed,
      coverage: `${report.coveragePercent}%`,
    });

    return report;
  }

  private async reviewPhase(): Promise<void> {
    this.state.currentPhase = 'reviewing';
    this.log.info('Phase: REVIEW');

    const recentlyCompleted = this.memory
      .loadAllTasks()
      .filter(
        (t) =>
          t.status === 'COMPLETE' &&
          t.result &&
          !this.state.completedTaskIds.slice(0, -3).includes(t.id) // only review last 3
      );

    for (const task of recentlyCompleted.slice(-3)) {
      try {
        const review = await this.reviewer.review(task);
        this.log.info('Review result', {
          taskId: task.id,
          score: review.score,
          passed: review.passed,
          critiques: review.critiques.length,
        });

        // If review fails, retry the task
        if (!review.passed && task.retryCount < 2) {
          this.log.warn('Review failed — requeueing task', { taskId: task.id });
          this.queue.retry(task.id);
          this.state.completedTaskIds = this.state.completedTaskIds.filter(
            (id) => id !== task.id
          );
        }
      } catch (err) {
        this.log.warn('Review error (non-fatal)', { taskId: task.id, err: String(err) });
      }
    }

    this.state.criticalIssueCount = this.reviewer.countCriticalIssues();
  }

  private costCheckPhase(): LoopExitReason | null {
    const stats = this.optimizer.getStats();

    this.state.totalInputTokens = stats.totalInputTokens;
    this.state.totalOutputTokens = stats.totalOutputTokens;
    this.state.totalCostUsd = stats.totalSpendUsd;

    this.log.info('Phase: COST', {
      spentUsd: stats.totalSpendUsd.toFixed(4),
      remainingUsd: stats.remainingBudgetUsd.toFixed(4),
      cacheHits: stats.cacheEntries,
    });

    if (this.optimizer.isBudgetExceeded()) {
      return this.buildExit(
        'cost-exceeded',
        `Total spend $${stats.totalSpendUsd.toFixed(4)} exceeds budget $${this.config.maxCostUsd}`
      );
    }

    return null;
  }

  private updateMemoryPhase(testReport: TestReport): void {
    this.state.currentPhase = 'idle';
    this.state.lastUpdatedAt = new Date().toISOString();
    this.persistState();

    this.log.info('Phase: MEMORY UPDATED', this.memory.getSummary());
  }

  // ── Exit conditions ────────────────────────────────────────────────────────

  private checkExitConditions(): LoopExitReason | null {
    const {
      coveragePercent,
      testsPassing,
      criticalIssueCount,
      completedTaskIds,
    } = this.state;

    if (
      coveragePercent >= this.config.targetCoveragePercent &&
      testsPassing &&
      criticalIssueCount <= this.config.maxCriticalIssues
    ) {
      return this.buildExit(
        'no-critical-issues',
        `All exit conditions met: coverage ${coveragePercent}%, tests passing, ` +
          `${criticalIssueCount} critical issues`
      );
    }

    if (this.queue.isComplete() && completedTaskIds.length > 0) {
      return this.buildExit(
        'all-tasks-complete',
        `All ${completedTaskIds.length} tasks completed`
      );
    }

    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private initState(): ProjectState {
    const existing = this.memory.loadState(this.config.projectId);
    if (existing) {
      this.log.info('Resuming project from persisted state', {
        projectId: this.config.projectId,
        iteration: existing.iterationCount,
      });
      this.optimizer.restoreFromState(
        existing.totalInputTokens,
        existing.totalOutputTokens
      );
      return existing;
    }

    return {
      projectId: this.config.projectId,
      goal: this.config.goal,
      currentPhase: 'init',
      iterationCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      coveragePercent: 0,
      testsPassing: false,
      criticalIssueCount: 0,
      completedTaskIds: [],
      failedTaskIds: [],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private persistState(): void {
    this.memory.saveState(this.state);
  }

  private buildExit(
    reason: LoopExitReason['reason'],
    detail: string
  ): LoopExitReason {
    this.log.info(`\n=== LOOP EXIT: ${reason.toUpperCase()} ===`, { detail });
    this.persistState();
    return { reason, detail, finalState: { ...this.state } };
  }
}
