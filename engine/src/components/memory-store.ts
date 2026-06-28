import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ArchitectureDecision,
  Critique,
  ProjectState,
  Task,
  TaskResult,
} from '../core/types';
import { createLogger } from '../core/logger';

/**
 * File-system backed memory store. No external services, no MCP.
 *
 * Layout:
 *   memory/
 *     state/project.json          ← single project state document
 *     tasks/<id>.json             ← one file per task
 *     critiques/<id>.json         ← one file per critique
 *     decisions/<id>.json         ← one file per ADR
 *     files/<path-hash>.json      ← metadata for generated files
 *     cache/<hash>.json           ← cost-optimizer response cache
 */
export class MemoryStore {
  private readonly dirs: Record<string, string>;
  private readonly log = createLogger('MemoryStore');

  constructor(memoryDir: string) {
    this.dirs = {
      root: memoryDir,
      state: join(memoryDir, 'state'),
      tasks: join(memoryDir, 'tasks'),
      critiques: join(memoryDir, 'critiques'),
      decisions: join(memoryDir, 'decisions'),
      files: join(memoryDir, 'files'),
      cache: join(memoryDir, 'cache'),
    };

    for (const dir of Object.values(this.dirs)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // ── Project State ──────────────────────────────────────────────────────────

  saveState(state: ProjectState): void {
    const path = join(this.dirs.state, 'project.json');
    this.write(path, state);
    this.log.debug('Project state saved', { projectId: state.projectId });
  }

  loadState(projectId: string): ProjectState | null {
    const path = join(this.dirs.state, 'project.json');
    const state = this.read<ProjectState>(path);
    if (state && state.projectId === projectId) return state;
    return null;
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  saveTask(task: Task): void {
    const path = join(this.dirs.tasks, `${task.id}.json`);
    this.write(path, task);
    this.log.debug('Task saved', { taskId: task.id, status: task.status });
  }

  loadTask(taskId: string): Task | null {
    const path = join(this.dirs.tasks, `${taskId}.json`);
    return this.read<Task>(path);
  }

  loadAllTasks(): Task[] {
    return this.readDir<Task>(this.dirs.tasks);
  }

  updateTaskResult(taskId: string, result: TaskResult): void {
    const task = this.loadTask(taskId);
    if (!task) {
      this.log.warn('Cannot update result — task not found', { taskId });
      return;
    }
    task.result = result;
    task.status = 'COMPLETE';
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
  }

  // ── Critiques ──────────────────────────────────────────────────────────────

  saveCritique(critique: Critique): void {
    const path = join(this.dirs.critiques, `${critique.id}.json`);
    this.write(path, critique);
  }

  loadCritiquesForTask(taskId: string): Critique[] {
    return this.readDir<Critique>(this.dirs.critiques).filter(
      (c) => c.taskId === taskId
    );
  }

  loadAllCritiques(): Critique[] {
    return this.readDir<Critique>(this.dirs.critiques);
  }

  // ── Architecture Decisions ─────────────────────────────────────────────────

  saveDecision(decision: ArchitectureDecision): void {
    const path = join(this.dirs.decisions, `${decision.id}.json`);
    this.write(path, decision);
    this.log.info('Architecture decision recorded', { title: decision.title });
  }

  loadAllDecisions(): ArchitectureDecision[] {
    return this.readDir<ArchitectureDecision>(this.dirs.decisions);
  }

  // ── Generated File Metadata ────────────────────────────────────────────────

  recordGeneratedFile(filePath: string, taskId: string, content?: string): void {
    const key = this.pathKey(filePath);
    const path = join(this.dirs.files, `${key}.json`);
    this.write(path, {
      filePath,
      taskId,
      recordedAt: new Date().toISOString(),
      contentLength: content?.length ?? 0,
    });
  }

  loadGeneratedFilePaths(): string[] {
    return this.readDir<{ filePath: string }>(this.dirs.files).map(
      (f) => f.filePath
    );
  }

  // ── Response Cache ─────────────────────────────────────────────────────────

  getCached(cacheKey: string): string | null {
    const path = join(this.dirs.cache, `${cacheKey}.json`);
    if (!existsSync(path)) return null;
    const entry = this.read<{ response: string; cachedAt: string }>(path);
    return entry?.response ?? null;
  }

  putCache(cacheKey: string, response: string): void {
    const path = join(this.dirs.cache, `${cacheKey}.json`);
    this.write(path, { response, cachedAt: new Date().toISOString() });
  }

  getCacheSize(): number {
    return readdirSync(this.dirs.cache).filter((f) => f.endsWith('.json')).length;
  }

  // ── OUTBOX (cross-run learning log) ───────────────────────────────────────

  /** Append a dated entry to .goalforge/OUTBOX.md for the next run to read. */
  appendOutbox(entry: string): void {
    const path = join(this.dirs.root, '..', 'OUTBOX.md');
    appendFileSync(path, entry, 'utf-8');
  }

  /** Return the last `maxChars` of OUTBOX.md for context injection. */
  readOutbox(maxChars = 2000): string {
    const path = join(this.dirs.root, '..', 'OUTBOX.md');
    if (!existsSync(path)) return '';
    const content = readFileSync(path, 'utf-8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Remove stale files that are no longer needed for the next run:
   *  - critique files for tasks that have been completed and passed review
   *  - oldest cache entries beyond `maxCacheEntries` to cap disk growth
   */
  cleanupMemory(
    completedTaskIds: string[],
    maxCacheEntries = 200
  ): { critiquesRemoved: number; cacheEntriesRemoved: number } {
    let critiquesRemoved = 0;
    let cacheEntriesRemoved = 0;

    // Drop critiques for fully-completed tasks — they won't be reviewed again.
    const completedSet = new Set(completedTaskIds);
    for (const critique of this.readDir<{ id: string; taskId: string }>(this.dirs.critiques)) {
      if (completedSet.has(critique.taskId)) {
        try {
          unlinkSync(join(this.dirs.critiques, `${critique.id}.json`));
          critiquesRemoved++;
        } catch { /* non-fatal */ }
      }
    }

    // Evict the oldest cache entries once the cache grows beyond the cap.
    const cacheFiles = readdirSync(this.dirs.cache)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const path = join(this.dirs.cache, f);
        const entry = this.read<{ cachedAt: string }>(path);
        return { path, cachedAt: entry?.cachedAt ?? '' };
      })
      .sort((a, b) => a.cachedAt.localeCompare(b.cachedAt)); // oldest first

    const excess = cacheFiles.length - maxCacheEntries;
    for (let i = 0; i < excess; i++) {
      try {
        unlinkSync(cacheFiles[i].path);
        cacheEntriesRemoved++;
      } catch { /* non-fatal */ }
    }

    return { critiquesRemoved, cacheEntriesRemoved };
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  getSummary(): {
    taskCount: number;
    completedCount: number;
    critiqueCount: number;
    decisionCount: number;
    generatedFileCount: number;
    cacheEntries: number;
  } {
    const tasks = this.loadAllTasks();
    return {
      taskCount: tasks.length,
      completedCount: tasks.filter((t) => t.status === 'COMPLETE').length,
      critiqueCount: this.readDir(this.dirs.critiques).length,
      decisionCount: this.readDir(this.dirs.decisions).length,
      generatedFileCount: this.readDir(this.dirs.files).length,
      cacheEntries: this.getCacheSize(),
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private write(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  }

  private read<T>(path: string): T | null {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch (err) {
      this.log.warn('Failed to read file', { path, err: String(err) });
      return null;
    }
  }

  private readDir<T>(dir: string): T[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => this.read<T>(join(dir, f)))
        .filter((x): x is T => x !== null);
    } catch {
      return [];
    }
  }

  private pathKey(filePath: string): string {
    // deterministic safe filename from arbitrary path
    return filePath
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 120);
  }
}
