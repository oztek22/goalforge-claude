import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { LoopConfig, LoopExitReason, ProjectState, Task, TestReport } from './core/types';

// Max independent tasks to execute simultaneously (each spawns its own Claude process).
const MAX_PARALLEL_TASKS = 3;
// Max tasks to review simultaneously.
const MAX_PARALLEL_REVIEWS = 3;
// Halt if this many consecutive iterations complete with zero new task completions.
const STALL_THRESHOLD = 3;

import { DEFAULT_BUDGET } from './core/config';
import { createLogger } from './core/logger';
import * as StatusBar from './core/status-bar';
import { MemoryStore } from './components/memory-store';
import { TaskQueue } from './components/task-queue';
import { CostOptimizer } from './components/cost-optimizer';
import { Planner } from './components/planner';
import { Executor } from './components/executor';
import { Reviewer } from './components/reviewer';
import { TestRunner } from './components/test-runner';
import { InteractiveSession } from './components/interactive';
import { RateLimitError } from './components/claude-cli';

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
  private consecutiveZeroProgress = 0;
  private readonly stopFile: string;

  constructor(
    private readonly config: LoopConfig,
    private readonly session?: InteractiveSession
  ) {
    this.memory = new MemoryStore(config.memoryDir);
    this.stopFile = join(config.memoryDir, '..', 'STOP');
    this.queue = new TaskQueue(this.memory);
    this.optimizer = new CostOptimizer(
      { ...DEFAULT_BUDGET, maxCostUsd: config.maxCostUsd },
      this.memory
    );
    this.planner = new Planner(this.optimizer, this.memory, config.dryRun, config.claudeTimeoutMs, config.planModel);
    this.executor = new Executor(
      config.workspaceDir,
      this.optimizer,
      this.memory,
      config.dryRun,
      config.claudeTimeoutMs,
      config.execModel
    );
    this.reviewer = new Reviewer(this.optimizer, this.memory, config.dryRun, config.claudeTimeoutMs, config.execModel);
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
      // ── File-based STOP switch ──────────────────────────────────────────────
      // `touch .goalforge/STOP` halts the loop gracefully at an iteration boundary.
      if (existsSync(this.stopFile)) {
        unlinkSync(this.stopFile);
        return this.buildExit('user-quit', 'Stopped via .goalforge/STOP file');
      }

      iteration++;
      this.state.iterationCount = iteration;

      StatusBar.update({ phase: 'planning', iteration });
      this.log.info(`\n━━━ Iteration ${iteration}/${this.config.maxIterations} ━━━`);

      const completedAtStart = this.state.completedTaskIds.length;

      try {
        // ── 1. Plan ──────────────────────────────────────────────────────────
        const exitAfterPlan = await this.planPhase();
        if (exitAfterPlan) return exitAfterPlan;

        // ── 2. Execute ────────────────────────────────────────────────────────
        const exitAfterExec = await this.executePhase();
        if (exitAfterExec) return exitAfterExec;

        // ── 3. Test + Review (concurrent) ─────────────────────────────────────
        // testPhase uses async exec so it doesn't block the event loop,
        // allowing review Claude calls to proceed in true parallel.
        const [testReport] = await Promise.all([
          this.testPhase(),
          this.reviewPhase(),
        ]);

        // ── 4. Cost check ──────────────────────────────────────────────────────
        const exitAfterCost = this.costCheckPhase();
        if (exitAfterCost) return exitAfterCost;

        // ── 5. Update memory / cleanup / check exit conditions ─────────────────
        const phaseAtPause = this.state.currentPhase;
        this.updateMemoryPhase(testReport);
        this.cleanupPhase();
        const exitCondition = this.checkExitConditions();
        if (exitCondition) return exitCondition;

        // ── 6. Interactive pause (Ctrl+C) ──────────────────────────────────────
        if (this.session?.isPaused()) {
          const result = await this.session.promptMidLoop(
            phaseAtPause,
            this.state.iterationCount
          );
          if (result.action === 'quit') {
            return this.buildExit('user-quit', 'User quit at interactive prompt');
          }
          if (result.action === 'redo') {
            const detail = result.feedback
              ? `User requested redo: ${result.feedback}`
              : 'User requested redo';
            if (result.feedback) this.appendFeedbackToGoal(result.feedback);
            return this.buildExit('user-redo', detail);
          }
          if (result.feedback) {
            this.appendFeedbackToGoal(result.feedback);
            this.log.info('User feedback injected into goal');
          }
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          this.persistState();
          return this.buildExit('rate-limited', err.message);
        }
        throw err;
      }

      // ── Budget safety net: stall detection ─────────────────────────────────
      // If N consecutive iterations produce zero new completions, the loop is
      // grinding on broken state. Halt loudly rather than burning budget silently.
      const newCompletions = this.state.completedTaskIds.length - completedAtStart;
      if (newCompletions === 0) {
        this.consecutiveZeroProgress++;
        if (this.consecutiveZeroProgress >= STALL_THRESHOLD) {
          return this.buildExit(
            'stalled',
            `No task completions in ${STALL_THRESHOLD} consecutive iterations — loop is stuck`
          );
        }
        this.log.warn(
          `Zero progress this iteration (${this.consecutiveZeroProgress}/${STALL_THRESHOLD} before stall halt)`
        );
      } else {
        this.consecutiveZeroProgress = 0;
      }
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
    this.session?.reportPhase('planning');
    StatusBar.update({ phase: 'planning' });

    if (this.queue.nextEligible() !== null) {
      this.log.debug('Eligible tasks already in queue — skipping re-planning');
      return null;
    }

    // If tasks exist but none are eligible, something is genuinely blocked —
    // don't trigger another plan cycle that would just duplicate the stuck tasks.
    const stats = this.queue.stats();
    const pendingCount = stats.PENDING + stats.RUNNING + stats.BLOCKED;
    if (pendingCount > 0) {
      this.log.warn('Tasks pending but none eligible — possible broken dependency chain', { stats });
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
      if (err instanceof RateLimitError) throw err;
      this.log.error('Planner failed', { err: String(err) });
    }

    return null;
  }

  private async executePhase(): Promise<LoopExitReason | null> {
    this.state.currentPhase = 'executing';
    this.session?.reportPhase('executing');
    StatusBar.update({ phase: 'executing' });
    StatusBar.clearAllTasks(); // clear planner/review rows from previous phase

    if (this.optimizer.isBudgetExceeded()) {
      return this.buildExit('cost-exceeded', 'Budget exceeded during execution');
    }
    if (this.session?.isPaused()) return null;

    // Collect up to MAX_PARALLEL_TASKS independent eligible tasks.
    // Calling start() marks each RUNNING so nextEligible() skips it on the
    // next iteration — only tasks whose dependencies are all COMPLETE are picked.
    const batch: Task[] = [];
    let candidate = this.queue.nextEligible();
    while (candidate !== null && batch.length < MAX_PARALLEL_TASKS) {
      this.queue.start(candidate.id);
      batch.push(candidate);
      candidate = this.queue.nextEligible();
    }

    if (batch.length === 0) {
      this.log.warn('No eligible tasks to execute');
      return null;
    }

    const label = batch.length > 1 ? `${batch.length} tasks in parallel` : '1 task';
    this.log.info(`Phase: EXECUTE — ${label}`, { queueStats: this.queue.stats() });
    batch.forEach(t => this.log.info(`▶ Starting: "${t.objective}"`));

    // All Claude subprocesses run in parallel at the OS level.
    const outcomes = await Promise.allSettled(
      batch.map(task => this.executor.execute(task))
    );

    const toRepair: Array<{ task: Task; error: string }> = [];

    for (let i = 0; i < batch.length; i++) {
      const task = batch[i];
      const outcome = outcomes[i];

      if (outcome.status === 'fulfilled') {
        this.queue.update(task.id, { result: outcome.value });
        this.queue.complete(task.id);
        this.state.completedTaskIds.push(task.id);
        StatusBar.update({ done: this.state.completedTaskIds.length, costUsd: this.state.totalCostUsd });
        this.log.info(`✓ Task complete (${this.state.completedTaskIds.length} done)`);
      } else {
        const error = String(outcome.reason);
        this.log.error('Execution failed', { taskId: task.id, err: error });
        this.queue.fail(task.id, error);
        this.state.failedTaskIds.push(task.id);
        StatusBar.update({ failed: this.state.failedTaskIds.length });

        if (task.retryCount < 2) {
          toRepair.push({ task, error });
        } else {
          this.log.warn(`Task exhausted retries — giving up`, { taskId: task.id });
        }
      }
    }

    // Repair failed tasks in parallel: Claude diagnoses root cause,
    // revises the objective, then re-queues for the next iteration.
    if (toRepair.length > 0) {
      this.log.info(`Repairing ${toRepair.length} failed task(s) in parallel`);
      await Promise.allSettled(
        toRepair.map(async ({ task, error }) => {
          try {
            const repair = await this.executor.repair(task, error);
            this.log.info(`Root cause: ${repair.rootCause}`);

            if (repair.revisedObjective) {
              this.queue.update(task.id, { objective: repair.revisedObjective });
              this.log.info(`Revised objective: "${repair.revisedObjective.slice(0, 80)}"`);
            } else {
              // No new objective, but append the root cause so the next
              // attempt has explicit context about what went wrong.
              const annotated = `${task.objective} [Previous attempt failed: ${repair.rootCause}]`;
              this.queue.update(task.id, { objective: annotated });
            }

            this.queue.retry(task.id);
            this.state.failedTaskIds = this.state.failedTaskIds.filter(id => id !== task.id);
            this.log.info(`Task re-queued for retry (attempt ${task.retryCount + 1})`);
          } catch (repairErr) {
            this.log.warn('Repair failed — task stays failed', { taskId: task.id, err: String(repairErr) });
          }
        })
      );
    }

    if (this.optimizer.isBudgetExceeded()) {
      return this.buildExit('cost-exceeded', 'Budget exceeded during execution');
    }

    // Re-throw a RateLimitError so the outer loop can sleep and retry.
    const rateLimitErr = outcomes
      .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
      .map((o) => o.reason)
      .find((r) => r instanceof RateLimitError);
    if (rateLimitErr) throw rateLimitErr;

    return null;
  }

  private async testPhase(): Promise<TestReport> {
    this.state.currentPhase = 'testing';
    this.session?.reportPhase('testing');
    StatusBar.update({ phase: 'testing' });
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
    this.session?.reportPhase('reviewing');
    StatusBar.update({ phase: 'reviewing' });
    StatusBar.clearAllTasks(); // clear executor rows
    this.log.info('Phase: REVIEW');

    if (this.session?.isPaused()) {
      this.state.criticalIssueCount = this.reviewer.countCriticalIssues();
      return;
    }

    const toReview = this.memory
      .loadAllTasks()
      .filter(
        (t) =>
          t.status === 'COMPLETE' &&
          t.result &&
          !this.state.completedTaskIds.slice(0, -MAX_PARALLEL_REVIEWS).includes(t.id)
      )
      .slice(-MAX_PARALLEL_REVIEWS);

    if (toReview.length > 0) {
      this.log.info(`Reviewing ${toReview.length} task(s) in parallel`);

      // Each review is an independent Claude call — run them all concurrently.
      await Promise.allSettled(
        toReview.map(async (task) => {
          try {
            const review = await this.reviewer.review(task);
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
        })
      );
    }

    this.state.criticalIssueCount = this.reviewer.countCriticalIssues();
  }

  private costCheckPhase(): LoopExitReason | null {
    this.session?.reportPhase('cost-check');
    StatusBar.update({ phase: 'cost-check' });
    const stats = this.optimizer.getStats();

    this.state.totalInputTokens = stats.totalInputTokens;
    this.state.totalOutputTokens = stats.totalOutputTokens;
    this.state.totalCostUsd = stats.totalSpendUsd;
    StatusBar.update({ costUsd: stats.totalSpendUsd });

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

  private updateMemoryPhase(_testReport: TestReport): void {
    this.state.currentPhase = 'idle';
    this.state.lastUpdatedAt = new Date().toISOString();
    this.persistState();
    StatusBar.update({ phase: 'idle' });
  }

  private cleanupPhase(): void {
    const stats = this.memory.cleanupMemory(this.state.completedTaskIds);
    if (stats.critiquesRemoved > 0 || stats.cacheEntriesRemoved > 0) {
      this.log.info('Memory cleanup', stats);
    }
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
        existing.totalOutputTokens,
        existing.totalCostUsd
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

  private appendFeedbackToGoal(feedback: string): void {
    this.config.goal += `\n\n[User feedback at iteration ${this.state.iterationCount}]: ${feedback}`;
  }

  private buildExit(
    reason: LoopExitReason['reason'],
    detail: string
  ): LoopExitReason {
    this.log.info(`\n=== LOOP EXIT: ${reason.toUpperCase()} ===`, { detail });
    this.persistState();
    this.writeOutbox(reason, detail);
    return { reason, detail, finalState: { ...this.state } };
  }

  /** Append a dated run summary to .goalforge/OUTBOX.md for the next run to learn from. */
  private writeOutbox(reason: string, detail: string): void {
    const entry = [
      `\n## Run ended ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
      `- Exit reason: ${reason} — ${detail}`,
      `- Completed: ${this.state.completedTaskIds.length} task(s)`,
      `- Failed: ${this.state.failedTaskIds.length} task(s)`,
      `- Iterations: ${this.state.iterationCount}`,
      `- Cost: $${this.state.totalCostUsd.toFixed(4)}`,
      `- Coverage: ${this.state.coveragePercent}%`,
      '',
    ].join('\n');
    try {
      this.memory.appendOutbox(entry);
    } catch {
      // non-fatal — OUTBOX write failure must not prevent normal exit
    }
  }

}
