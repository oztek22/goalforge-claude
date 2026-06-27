import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { MemoryStore } from '../../src/components/memory-store';
import { TaskQueue } from '../../src/components/task-queue';
import { PlannerOutput } from '../../src/core/types';

const TEST_DIR = join(__dirname, '../../task-queue-test-tmp');

function plan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    objective: 'Default objective',
    priority: 1,
    dependencies: [],
    estimatedEffort: 'low',
    ...overrides,
  };
}

describe('TaskQueue', () => {
  let memory: MemoryStore;
  let queue: TaskQueue;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    memory = new MemoryStore(TEST_DIR);
    queue = new TaskQueue(memory);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Enqueue ────────────────────────────────────────────────────────────────

  it('enqueues a task with PENDING status', () => {
    const task = queue.enqueue(plan({ objective: 'Task A' }));
    expect(task.status).toBe('PENDING');
    expect(task.objective).toBe('Task A');
    expect(task.id).toBeTruthy();
  });

  it('enqueueBatch enqueues multiple tasks', () => {
    queue.enqueueBatch([
      plan({ objective: 'A', priority: 1 }),
      plan({ objective: 'B', priority: 2 }),
    ]);
    expect(queue.size()).toBe(2);
  });

  // ── Dependency Resolution ──────────────────────────────────────────────────

  it('does not return tasks with incomplete dependencies as eligible', () => {
    const dep = queue.enqueue(plan({ objective: 'Dep' }));
    queue.enqueue(plan({ objective: 'Child', dependencies: [dep.id] }));
    // dep is PENDING, so child should not be eligible
    const eligible = queue.nextEligible();
    expect(eligible?.objective).toBe('Dep');
  });

  it('makes child eligible once dependency completes', () => {
    const dep = queue.enqueue(plan({ objective: 'Dep' }));
    const child = queue.enqueue(plan({ objective: 'Child', dependencies: [dep.id] }));
    queue.start(dep.id);
    queue.complete(dep.id);

    const eligible = queue.nextEligible();
    expect(eligible?.id).toBe(child.id);
  });

  it('returns highest priority task first', () => {
    queue.enqueue(plan({ objective: 'Low', priority: 5 }));
    queue.enqueue(plan({ objective: 'High', priority: 1 }));
    expect(queue.nextEligible()?.objective).toBe('High');
  });

  // ── Lifecycle transitions ──────────────────────────────────────────────────

  it('start() transitions PENDING → RUNNING', () => {
    const task = queue.enqueue(plan());
    queue.start(task.id);
    expect(queue.getById(task.id)?.status).toBe('RUNNING');
  });

  it('start() throws if task has unresolved dependencies', () => {
    const dep = queue.enqueue(plan({ objective: 'Dep' }));
    const child = queue.enqueue(plan({ objective: 'Child', dependencies: [dep.id] }));
    expect(() => queue.start(child.id)).toThrow();
  });

  it('complete() transitions to COMPLETE', () => {
    const task = queue.enqueue(plan());
    queue.start(task.id);
    queue.complete(task.id);
    expect(queue.getById(task.id)?.status).toBe('COMPLETE');
  });

  it('fail() transitions to FAILED with reason', () => {
    const task = queue.enqueue(plan());
    queue.fail(task.id, 'API error');
    expect(queue.getById(task.id)?.status).toBe('FAILED');
    expect(queue.getById(task.id)?.blockedReason).toBe('API error');
  });

  it('block() transitions to BLOCKED with reason', () => {
    const task = queue.enqueue(plan());
    queue.block(task.id, 'Waiting for auth');
    expect(queue.getById(task.id)?.status).toBe('BLOCKED');
  });

  it('retry() resets to PENDING and increments retryCount', () => {
    const task = queue.enqueue(plan());
    queue.fail(task.id, 'error');
    queue.retry(task.id);
    const updated = queue.getById(task.id)!;
    expect(updated.status).toBe('PENDING');
    expect(updated.retryCount).toBe(1);
    expect(updated.blockedReason).toBeUndefined();
  });

  // ── Stats ──────────────────────────────────────────────────────────────────

  it('stats() counts tasks by status', () => {
    const t1 = queue.enqueue(plan());
    const t2 = queue.enqueue(plan());
    queue.start(t1.id);
    queue.complete(t1.id);

    const stats = queue.stats();
    expect(stats.COMPLETE).toBe(1);
    expect(stats.PENDING).toBe(1);
  });

  it('isComplete() returns false when tasks remain', () => {
    queue.enqueue(plan());
    expect(queue.isComplete()).toBe(false);
  });

  it('isComplete() returns true when all tasks are terminal', () => {
    const t1 = queue.enqueue(plan());
    const t2 = queue.enqueue(plan());
    queue.start(t1.id);
    queue.complete(t1.id);
    queue.fail(t2.id);
    expect(queue.isComplete()).toBe(true);
  });

  it('byStatus() filters correctly', () => {
    const t = queue.enqueue(plan());
    queue.fail(t.id, 'oops');
    expect(queue.byStatus('FAILED')).toHaveLength(1);
    expect(queue.byStatus('PENDING')).toHaveLength(0);
  });

  // ── getById ────────────────────────────────────────────────────────────────

  it('getById returns undefined for unknown id', () => {
    expect(queue.getById('nonexistent')).toBeUndefined();
  });

  // ── Throws on unknown id ───────────────────────────────────────────────────

  it('start() throws for unknown task id', () => {
    expect(() => queue.start('ghost')).toThrow('Task not found');
  });
});
