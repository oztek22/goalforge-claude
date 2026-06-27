import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { MemoryStore } from '../../src/components/memory-store';
import { ArchitectureDecision, Critique, ProjectState, Task } from '../../src/core/types';

const TEST_DIR = join(__dirname, '../../memory-test-tmp');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    objective: 'Test task',
    priority: 1,
    dependencies: [],
    estimatedEffort: 'low',
    status: 'PENDING',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: 'proj-1',
    goal: 'Test goal',
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

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DIR);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── State ──────────────────────────────────────────────────────────────────

  describe('project state', () => {
    it('saves and loads state', () => {
      const state = makeState({ projectId: 'proj-1', iterationCount: 3 });
      store.saveState(state);
      expect(store.loadState('proj-1')).toEqual(state);
    });

    it('returns null for unknown project', () => {
      expect(store.loadState('nonexistent')).toBeNull();
    });

    it('does not return state for wrong projectId', () => {
      store.saveState(makeState({ projectId: 'proj-A' }));
      expect(store.loadState('proj-B')).toBeNull();
    });
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────

  describe('tasks', () => {
    it('saves and loads a task', () => {
      const task = makeTask({ id: 'task-abc' });
      store.saveTask(task);
      expect(store.loadTask('task-abc')).toEqual(task);
    });

    it('returns null for missing task', () => {
      expect(store.loadTask('not-here')).toBeNull();
    });

    it('loads all tasks', () => {
      store.saveTask(makeTask({ id: 't1' }));
      store.saveTask(makeTask({ id: 't2' }));
      const all = store.loadAllTasks();
      expect(all.map((t) => t.id)).toEqual(expect.arrayContaining(['t1', 't2']));
    });

    it('updates task result and marks COMPLETE', () => {
      store.saveTask(makeTask({ id: 'task-res' }));
      store.updateTaskResult('task-res', {
        output: 'done',
        filesCreated: [],
        filesModified: [],
        commandsRun: [],
        tokenUsage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0 },
        executedAt: new Date().toISOString(),
      });
      const updated = store.loadTask('task-res');
      expect(updated?.status).toBe('COMPLETE');
      expect(updated?.result?.output).toBe('done');
    });

    it('logs warning when updating non-existent task', () => {
      expect(() =>
        store.updateTaskResult('ghost', {
          output: 'x',
          filesCreated: [],
          filesModified: [],
          commandsRun: [],
          tokenUsage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          executedAt: new Date().toISOString(),
        })
      ).not.toThrow();
    });
  });

  // ── Critiques ──────────────────────────────────────────────────────────────

  describe('critiques', () => {
    const crit: Critique = {
      id: 'c1',
      taskId: 'task-1',
      severity: 'high',
      category: 'correctness',
      description: 'Missing error handling',
      suggestion: 'Add try/catch',
      createdAt: new Date().toISOString(),
    };

    it('saves and retrieves critiques by task', () => {
      store.saveCritique(crit);
      expect(store.loadCritiquesForTask('task-1')).toHaveLength(1);
    });

    it('does not return critiques for other tasks', () => {
      store.saveCritique(crit);
      expect(store.loadCritiquesForTask('task-99')).toHaveLength(0);
    });

    it('loads all critiques', () => {
      store.saveCritique(crit);
      store.saveCritique({ ...crit, id: 'c2', taskId: 'task-2' });
      expect(store.loadAllCritiques().length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Decisions ──────────────────────────────────────────────────────────────

  describe('architecture decisions', () => {
    it('saves and loads decisions', () => {
      const decision: ArchitectureDecision = {
        id: 'adr-1',
        title: 'Use TypeScript',
        context: 'Need type safety',
        decision: 'TypeScript everywhere',
        consequences: 'Build step required',
        madeAt: new Date().toISOString(),
      };
      store.saveDecision(decision);
      expect(store.loadAllDecisions()).toHaveLength(1);
    });
  });

  // ── Cache ──────────────────────────────────────────────────────────────────

  describe('response cache', () => {
    it('returns null on cache miss', () => {
      expect(store.getCached('nonexistent-key')).toBeNull();
    });

    it('stores and retrieves cached response', () => {
      store.putCache('key123', 'cached response text');
      expect(store.getCached('key123')).toBe('cached response text');
    });

    it('tracks cache size', () => {
      const before = store.getCacheSize();
      store.putCache('size-test-key', 'value');
      expect(store.getCacheSize()).toBeGreaterThan(before);
    });
  });

  // ── Generated Files ────────────────────────────────────────────────────────

  describe('generated files', () => {
    it('records and retrieves generated file paths', () => {
      store.recordGeneratedFile('/workspace/src/app.ts', 'task-1');
      const paths = store.loadGeneratedFilePaths();
      expect(paths).toContain('/workspace/src/app.ts');
    });
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  describe('summary', () => {
    it('returns correct counts', () => {
      const summary = store.getSummary();
      expect(summary).toHaveProperty('taskCount');
      expect(summary).toHaveProperty('critiqueCount');
      expect(summary).toHaveProperty('cacheEntries');
    });
  });
});
