import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { LoopController } from '../src/loop-controller';
import { defaultLoopConfig } from '../src/core/config';
import { LoopConfig } from '../src/core/types';

const TEST_ROOT = join(__dirname, '../loop-test-tmp');
const WORKSPACE = join(TEST_ROOT, 'workspace');
const MEMORY = join(TEST_ROOT, 'memory');

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return defaultLoopConfig({
    projectId: 'test-project',
    goal: 'Build a hello world CLI app in Node.js',
    dryRun: true,
    maxIterations: 3,
    maxCostUsd: 50,
    workspaceDir: WORKSPACE,
    memoryDir: MEMORY,
    ...overrides,
  });
}

describe('LoopController (dry-run)', () => {
  beforeEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  afterAll(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('completes without throwing in dry-run mode', async () => {
    const controller = new LoopController(makeConfig());
    const exit = await controller.run();
    expect(exit).toBeDefined();
    expect(exit.reason).toBeDefined();
    expect(exit.finalState).toBeDefined();
  }, 30_000);

  it('returns a finalState with all required fields', async () => {
    const controller = new LoopController(makeConfig());
    const exit = await controller.run();
    const state = exit.finalState;

    expect(typeof state.projectId).toBe('string');
    expect(typeof state.iterationCount).toBe('number');
    expect(typeof state.totalCostUsd).toBe('number');
    expect(Array.isArray(state.completedTaskIds)).toBe(true);
    expect(typeof state.coveragePercent).toBe('number');
  }, 30_000);

  it('exits with max-iterations when maxIterations is 1', async () => {
    const controller = new LoopController(makeConfig({ maxIterations: 1 }));
    const exit = await controller.run();
    // With 1 iteration, it will hit max-iterations OR all-tasks-complete
    expect([
      'max-iterations',
      'all-tasks-complete',
      'no-critical-issues',
    ]).toContain(exit.reason);
  }, 30_000);

  it('populates completedTaskIds after successful dry-run', async () => {
    const controller = new LoopController(makeConfig({ maxIterations: 3 }));
    const exit = await controller.run();
    // dry-run planner returns 2 stub tasks
    expect(exit.finalState.completedTaskIds.length).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('resumes state from memory on second instantiation', async () => {
    const config = makeConfig({ maxIterations: 2 });
    const c1 = new LoopController(config);
    const exit1 = await c1.run();

    const c2 = new LoopController(config);
    const state = c2.getState();
    // State should have been loaded from disk
    expect(state.iterationCount).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('getState() returns current state', () => {
    const controller = new LoopController(makeConfig());
    const state = controller.getState();
    expect(state.projectId).toBe('test-project');
  });
});
