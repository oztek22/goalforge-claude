import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { MemoryStore } from '../../src/components/memory-store';
import { CostOptimizer } from '../../src/components/cost-optimizer';
import { Planner } from '../../src/components/planner';
import { DEFAULT_BUDGET } from '../../src/core/config';
import { ProjectState } from '../../src/core/types';

const TEST_DIR = join(__dirname, '../../planner-test-tmp');

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: 'test-proj',
    goal: 'test goal',
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
    ...overrides,
  };
}

describe('Planner (dry-run)', () => {
  let memory: MemoryStore;
  let optimizer: CostOptimizer;
  let planner: Planner;

  beforeEach(() => {
    memory = new MemoryStore(TEST_DIR);
    optimizer = new CostOptimizer(DEFAULT_BUDGET, memory);
    planner = new Planner(optimizer, memory, true); // dryRun = true
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns an array of PlannerOutput objects', async () => {
    const plans = await planner.plan('Build a CLI app', makeState());
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBeGreaterThan(0);
  });

  it('each plan has required fields', async () => {
    const plans = await planner.plan('Build something', makeState());
    for (const p of plans) {
      expect(typeof p.objective).toBe('string');
      expect(typeof p.priority).toBe('number');
      expect(Array.isArray(p.dependencies)).toBe(true);
      expect(['low', 'medium', 'high']).toContain(p.estimatedEffort);
    }
  });

  it('saves architecture decisions to memory', async () => {
    await planner.plan('Some goal', makeState());
    const decisions = memory.loadAllDecisions();
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('uses cache on second call with same goal', async () => {
    const goal = 'Cached goal';
    const state = makeState();
    await planner.plan(goal, state);
    const callsBefore = optimizer.getStats().callCount;
    await planner.plan(goal, state);
    // Second call should use cache → same call count
    expect(optimizer.getStats().callCount).toBe(callsBefore);
  });

  it('returns empty array when budget is exhausted', async () => {
    // Exhaust budget
    optimizer.recordUsage({ inputTokens: 10_000_000, outputTokens: 0, estimatedCostUsd: 0 });
    const plans = await planner.plan('Any goal', makeState());
    expect(plans).toHaveLength(0);
  });
});
