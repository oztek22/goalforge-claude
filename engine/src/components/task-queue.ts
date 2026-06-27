import { randomUUID } from 'crypto';
import { PlannerOutput, Task, TaskStatus } from '../core/types';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';

/**
 * In-memory task queue backed by MemoryStore for persistence.
 * Respects dependency ordering: a task is only eligible when all its
 * dependency task IDs are in COMPLETE status.
 */
export class TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private readonly log = createLogger('TaskQueue');

  constructor(private readonly memory: MemoryStore) {
    this.hydrate();
  }

  // ── Mutation ───────────────────────────────────────────────────────────────

  enqueue(plan: PlannerOutput): Task {
    const task: Task = {
      ...plan,
      id: randomUUID(),
      status: 'PENDING',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);
    this.memory.saveTask(task);
    this.log.info('Task enqueued', { taskId: task.id, objective: task.objective });
    return task;
  }

  enqueueBatch(plans: PlannerOutput[]): Task[] {
    return plans.map((p) => this.enqueue(p));
  }

  /** Move a task to RUNNING. Throws if it cannot run yet. */
  start(taskId: string): Task {
    const task = this.getOrThrow(taskId);

    if (!this.canRun(task)) {
      throw new Error(`Task ${taskId} has unresolved dependencies or is not PENDING`);
    }

    task.status = 'RUNNING';
    task.updatedAt = new Date().toISOString();
    this.persist(task);
    return task;
  }

  complete(taskId: string): Task {
    return this.transition(taskId, 'COMPLETE');
  }

  fail(taskId: string, reason?: string): Task {
    const task = this.transition(taskId, 'FAILED');
    task.blockedReason = reason;
    this.persist(task);
    return task;
  }

  block(taskId: string, reason: string): Task {
    const task = this.transition(taskId, 'BLOCKED');
    task.blockedReason = reason;
    this.persist(task);
    return task;
  }

  retry(taskId: string): Task {
    const task = this.getOrThrow(taskId);
    task.status = 'PENDING';
    task.retryCount += 1;
    task.blockedReason = undefined;
    task.updatedAt = new Date().toISOString();
    this.persist(task);
    this.log.info('Task queued for retry', { taskId, retryCount: task.retryCount });
    return task;
  }

  update(taskId: string, updates: Partial<Task>): Task {
    const task = this.getOrThrow(taskId);
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    this.persist(task);
    return task;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Returns the highest-priority PENDING task whose dependencies are all COMPLETE. */
  nextEligible(): Task | null {
    const eligible = [...this.tasks.values()]
      .filter((t) => t.status === 'PENDING' && this.canRun(t))
      .sort((a, b) => a.priority - b.priority);

    return eligible[0] ?? null;
  }

  byStatus(status: TaskStatus): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === status);
  }

  getById(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  size(): number {
    return this.tasks.size;
  }

  isComplete(): boolean {
    return (
      this.tasks.size > 0 &&
      [...this.tasks.values()].every(
        (t) => t.status === 'COMPLETE' || t.status === 'FAILED'
      )
    );
  }

  stats(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      PENDING: 0,
      RUNNING: 0,
      BLOCKED: 0,
      COMPLETE: 0,
      FAILED: 0,
    };
    for (const t of this.tasks.values()) {
      counts[t.status]++;
    }
    return counts;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private canRun(task: Task): boolean {
    if (task.status !== 'PENDING') return false;
    return task.dependencies.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'COMPLETE';
    });
  }

  private transition(taskId: string, status: TaskStatus): Task {
    const task = this.getOrThrow(taskId);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.persist(task);
    this.log.debug(`Task → ${status}`, { taskId });
    return task;
  }

  private getOrThrow(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private persist(task: Task): void {
    this.tasks.set(task.id, task);
    this.memory.saveTask(task);
  }

  /** Load tasks that were persisted in a previous run. */
  private hydrate(): void {
    const persisted = this.memory.loadAllTasks();
    for (const task of persisted) {
      // Tasks that were RUNNING when the process died become PENDING again
      if (task.status === 'RUNNING') {
        task.status = 'PENDING';
        task.updatedAt = new Date().toISOString();
      }
      this.tasks.set(task.id, task);
    }
    if (persisted.length > 0) {
      this.log.info('Hydrated task queue from disk', { count: persisted.length });
    }
  }
}
