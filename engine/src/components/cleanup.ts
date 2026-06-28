import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../core/logger';
import { LoopExitReason } from '../core/types';

export interface CleanupResult {
  tasksRemoved: number;
  critiquesRemoved: number;
  cacheEntriesRemoved: number;
  fileMetadataRemoved: number;
  stateCleared: boolean;
}

const SUCCESS_EXITS = new Set<LoopExitReason['reason']>([
  'no-critical-issues',
  'all-tasks-complete',
  'coverage-met',
  'tests-passing',
]);

const log = createLogger('Cleanup');

/** Returns true when the exit reason indicates the loop completed its goal. */
export function isSuccessExit(reason: LoopExitReason['reason']): boolean {
  return SUCCESS_EXITS.has(reason);
}

/**
 * Removes all run-specific memory files after a successful loop completion.
 *
 * Clears: tasks/, critiques/, cache/, files/, state/project.json
 * Preserves: decisions/ (ADRs carry forward), OUTBOX.md (cross-run learning)
 */
export function cleanupAfterSuccess(memoryDir: string): CleanupResult {
  const result: CleanupResult = {
    tasksRemoved: 0,
    critiquesRemoved: 0,
    cacheEntriesRemoved: 0,
    fileMetadataRemoved: 0,
    stateCleared: false,
  };

  result.tasksRemoved       = clearJsonDir(join(memoryDir, 'tasks'));
  result.critiquesRemoved   = clearJsonDir(join(memoryDir, 'critiques'));
  result.cacheEntriesRemoved = clearJsonDir(join(memoryDir, 'cache'));
  result.fileMetadataRemoved = clearJsonDir(join(memoryDir, 'files'));

  const statePath = join(memoryDir, 'state', 'project.json');
  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
      result.stateCleared = true;
    } catch { /* non-fatal */ }
  }

  const total =
    result.tasksRemoved +
    result.critiquesRemoved +
    result.cacheEntriesRemoved +
    result.fileMetadataRemoved +
    (result.stateCleared ? 1 : 0);

  if (total > 0) {
    log.info('Post-run cleanup complete', result);
  }

  return result;
}

function clearJsonDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      unlinkSync(join(dir, f));
      removed++;
    } catch { /* non-fatal — skip locked or already-gone files */ }
  }
  return removed;
}
