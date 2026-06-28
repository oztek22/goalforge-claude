import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { TestFailure, TestReport } from '../core/types';
import { createLogger } from '../core/logger';

const execAsync = promisify(exec);

const JSON_REPORTER_SENTINEL = /^{/m;

export class TestRunner {
  private readonly log = createLogger('TestRunner');

  constructor(private readonly workspaceDir: string) {}

  /**
   * Runs the test suite in workspaceDir and returns a structured report.
   * Supports Jest (detected via jest.config.* or package.json scripts).
   * Falls back to "npm test" if no Jest config is found.
   */
  async run(): Promise<TestReport> {
    this.log.info('Running tests', { workspaceDir: this.workspaceDir });

    if (!existsSync(this.workspaceDir)) {
      return this.emptyReport('Workspace directory does not exist');
    }

    const hasJestConfig =
      existsSync(join(this.workspaceDir, 'jest.config.ts')) ||
      existsSync(join(this.workspaceDir, 'jest.config.js')) ||
      existsSync(join(this.workspaceDir, 'jest.config.json'));
    const hasPkgJson = existsSync(join(this.workspaceDir, 'package.json'));

    if (!hasJestConfig && !hasPkgJson) {
      return this.emptyReport('No test setup found in workspace');
    }

    const runner = this.detectRunner();
    this.log.debug('Detected test runner', { runner });

    try {
      const raw = await this.execTests(runner);
      const report = this.parseOutput(raw, runner);
      this.log.info('Tests complete', {
        total: report.totalTests,
        passed: report.passed,
        failed: report.failed,
        coverage: report.coveragePercent,
      });
      return report;
    } catch (err: unknown) {
      // execSync throws on non-zero exit; capture the output anyway
      const stderr = err instanceof Error && 'stderr' in err
        ? String((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr ?? '')
        : String(err);
      const stdout = err instanceof Error && 'stdout' in err
        ? String((err as NodeJS.ErrnoException & { stdout?: Buffer }).stdout ?? '')
        : '';

      this.log.warn('Test command exited with non-zero code', {
        message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });

      return this.parseOutput(stdout + '\n' + stderr, runner);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private detectRunner(): 'jest-json' | 'jest' | 'npm-test' {
    const hasJestConfig =
      existsSync(join(this.workspaceDir, 'jest.config.ts')) ||
      existsSync(join(this.workspaceDir, 'jest.config.js')) ||
      existsSync(join(this.workspaceDir, 'jest.config.json'));

    if (hasJestConfig) return 'jest-json';

    const pkgPath = join(this.workspaceDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'));
        if (pkg.devDependencies?.jest || pkg.dependencies?.jest) return 'jest';
        if (pkg.scripts?.test) return 'npm-test';
      } catch {
        // ignore
      }
    }

    return 'npm-test';
  }

  private async execTests(runner: string): Promise<string> {
    const cmd =
      runner === 'jest-json'
        ? 'npx jest --json --coverage --passWithNoTests 2>&1 || true'
        : runner === 'jest'
        ? 'npx jest --coverage --passWithNoTests 2>&1 || true'
        : 'npm test 2>&1 || true';

    const { stdout, stderr } = await execAsync(cmd, {
      cwd: this.workspaceDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout + (stderr ? '\n' + stderr : '');
  }

  private parseOutput(raw: string, runner: string): TestReport {
    if (runner === 'jest-json') {
      return this.parseJestJson(raw);
    }
    return this.parseJestText(raw);
  }

  private parseJestJson(raw: string): TestReport {
    // Jest --json outputs a JSON object as the last line
    const lines = raw.split('\n').filter(Boolean);
    const jsonLine = lines.reverse().find((l) => JSON_REPORTER_SENTINEL.test(l));

    if (!jsonLine) return this.parseJestText(raw);

    try {
      const result = JSON.parse(jsonLine);
      const failures: TestFailure[] = [];

      for (const suite of result.testResults ?? []) {
        for (const t of suite.testResults ?? []) {
          if (t.status === 'failed') {
            failures.push({
              testName: t.fullName,
              file: suite.testFilePath,
              error: t.failureMessages?.[0] ?? 'Unknown failure',
            });
          }
        }
      }

      const coverage = this.extractCoverage(result.coverageMap);

      return {
        runAt: new Date().toISOString(),
        totalTests: result.numTotalTests ?? 0,
        passed: result.numPassedTests ?? 0,
        failed: result.numFailedTests ?? 0,
        skipped: result.numPendingTests ?? 0,
        coveragePercent: coverage,
        failures,
        rawOutput: raw.slice(0, 2000),
      };
    } catch {
      return this.parseJestText(raw);
    }
  }

  private parseJestText(raw: string): TestReport {
    // Heuristic parsing for jest text output or arbitrary test runners
    const testMatch = raw.match(/Tests:\s+(\d+)\s+passed.*?(\d+)\s+total/);
    const failMatch = raw.match(/(\d+)\s+failed/);
    const covMatch = raw.match(/All files\s*\|\s*([\d.]+)/);

    const total = testMatch ? parseInt(testMatch[2]) : 0;
    const failed = failMatch ? parseInt(failMatch[1]) : 0;
    const passed = total - failed;
    const coverage = covMatch ? parseFloat(covMatch[1]) : 0;

    // Extract failure blocks
    const failures: TestFailure[] = [];
    const failBlocks = raw.match(/● .+\n[\s\S]*?(?=\n●|\n\n[A-Z]|$)/g) ?? [];
    for (const block of failBlocks.slice(0, 20)) {
      const name = block.match(/● (.+)/)?.[1] ?? 'Unknown';
      failures.push({
        testName: name.trim(),
        file: 'unknown',
        error: block.slice(0, 500).trim(),
      });
    }

    return {
      runAt: new Date().toISOString(),
      totalTests: total,
      passed,
      failed,
      skipped: 0,
      coveragePercent: coverage,
      failures,
      rawOutput: raw.slice(0, 2000),
    };
  }

  private extractCoverage(coverageMap: Record<string, unknown> | undefined): number {
    if (!coverageMap) return 0;

    const totals: number[] = [];
    for (const file of Object.values(coverageMap)) {
      const f = file as Record<string, Record<string, { covered: number; total: number }>>;
      const statements = f?.s;
      if (!statements) continue;
      const vals = Object.values(statements);
      // istanbul coverage format: s = { "0": 1, "1": 0 } (1 = covered)
      const covered = Object.values(f.s ?? {}).filter((v) => Number(v) > 0).length;
      const total = Object.keys(f.s ?? {}).length;
      if (total > 0) totals.push((covered / total) * 100);
    }

    return totals.length > 0
      ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
      : 0;
  }

  private emptyReport(reason: string): TestReport {
    return {
      runAt: new Date().toISOString(),
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      coveragePercent: 0,
      failures: [],
      rawOutput: reason,
    };
  }
}
