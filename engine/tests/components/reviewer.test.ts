import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { MemoryStore } from '../../src/components/memory-store';
import { CostOptimizer } from '../../src/components/cost-optimizer';
import { Reviewer } from '../../src/components/reviewer';
import { DEFAULT_BUDGET } from '../../src/core/config';
import { Task } from '../../src/core/types';

const TEST_DIR = join(__dirname, '../../reviewer-test-tmp');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-rev-1',
    objective: 'Implement login endpoint',
    priority: 1,
    dependencies: [],
    estimatedEffort: 'medium',
    status: 'COMPLETE',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: {
      output: 'Login endpoint implemented with JWT auth',
      filesCreated: ['/workspace/src/auth.ts'],
      filesModified: [],
      commandsRun: [],
      tokenUsage: { inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0 },
      executedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe('Reviewer (dry-run)', () => {
  let memory: MemoryStore;
  let optimizer: CostOptimizer;
  let reviewer: Reviewer;

  beforeEach(() => {
    memory = new MemoryStore(TEST_DIR);
    optimizer = new CostOptimizer(DEFAULT_BUDGET, memory);
    reviewer = new Reviewer(optimizer, memory, true); // dryRun = true
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns a ReviewResult with required fields', async () => {
    const result = await reviewer.review(makeTask());
    expect(typeof result.score).toBe('number');
    expect(typeof result.passed).toBe('boolean');
    expect(Array.isArray(result.critiques)).toBe(true);
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(typeof result.reviewedAt).toBe('string');
  });

  it('score is between 0 and 100', async () => {
    const result = await reviewer.review(makeTask());
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('persists critiques to memory', async () => {
    const task = makeTask({ id: 'task-persist' });
    await reviewer.review(task);
    const critiques = memory.loadCritiquesForTask('task-persist');
    expect(critiques.length).toBeGreaterThan(0);
  });

  it('returns empty review for task without result', async () => {
    const task = makeTask({ result: undefined });
    const result = await reviewer.review(task);
    expect(result.passed).toBe(true); // defaults to pass when no result
  });

  it('countCriticalIssues returns 0 when none stored', () => {
    expect(reviewer.countCriticalIssues()).toBe(0);
  });

  it('countCriticalIssues counts stored critical critiques', async () => {
    // Store a critical critique manually
    memory.saveCritique({
      id: 'c-crit',
      taskId: 'task-rev-1',
      severity: 'critical',
      category: 'security',
      description: 'SQL injection vulnerability',
      suggestion: 'Use parameterised queries',
      createdAt: new Date().toISOString(),
    });
    expect(reviewer.countCriticalIssues()).toBe(1);
  });

  it('uses cache on repeated review of same task', async () => {
    const task = makeTask();
    await reviewer.review(task);
    const before = optimizer.getStats().callCount;
    await reviewer.review(task);
    expect(optimizer.getStats().callCount).toBe(before);
  });
});
