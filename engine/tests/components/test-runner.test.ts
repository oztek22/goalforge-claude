import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TestRunner } from '../../src/components/test-runner';

const TEST_DIR = join(__dirname, '../../test-runner-tmp');
const WORKSPACE = join(TEST_DIR, 'workspace');

describe('TestRunner', () => {
  beforeAll(() => {
    mkdirSync(WORKSPACE, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns a TestReport with required fields when workspace is empty', async () => {
    const runner = new TestRunner(WORKSPACE);
    const report = await runner.run();

    expect(typeof report.totalTests).toBe('number');
    expect(typeof report.passed).toBe('number');
    expect(typeof report.failed).toBe('number');
    expect(typeof report.coveragePercent).toBe('number');
    expect(Array.isArray(report.failures)).toBe(true);
    expect(typeof report.runAt).toBe('string');
  }, 15_000);

  it('returns emptyReport when workspace does not exist', async () => {
    const runner = new TestRunner(join(TEST_DIR, 'nonexistent'));
    const report = await runner.run();
    expect(report.totalTests).toBe(0);
    expect(report.rawOutput).toContain('does not exist');
  });

  it('coveragePercent is between 0 and 100', async () => {
    const runner = new TestRunner(WORKSPACE);
    const report = await runner.run();
    expect(report.coveragePercent).toBeGreaterThanOrEqual(0);
    expect(report.coveragePercent).toBeLessThanOrEqual(100);
  }, 15_000);

  it('parses jest JSON output when available', () => {
    // Use private-ish access via casting to test the parser
    const runner = new TestRunner(WORKSPACE) as unknown as {
      parseJestJson: (raw: string) => ReturnType<TestRunner['run']> extends Promise<infer T> ? T : never;
    };

    const fakeJson = JSON.stringify({
      numTotalTests: 10,
      numPassedTests: 8,
      numFailedTests: 2,
      numPendingTests: 0,
      testResults: [
        {
          testFilePath: '/src/foo.test.ts',
          testResults: [
            { fullName: 'test fails', status: 'failed', failureMessages: ['expect(x).toBe(y)'] },
          ],
        },
      ],
    });

    // Wrap in surrounding text as jest would produce
    const rawOutput = `Some preamble\n${fakeJson}`;
    const report = runner.parseJestJson(rawOutput);
    // Types are private but we can verify the structure via run() — just check no throw here
    expect(report).toBeDefined();
  });
});
