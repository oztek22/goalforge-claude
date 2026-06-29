import { join } from 'path';
import { CostBudget, LoopConfig } from './types';

export const DEFAULT_BUDGET: CostBudget = {
  maxCostUsd: 10.0,
  maxInputTokensPerCall: 100_000,
  maxOutputTokensPerCall: 8_000,
  warnThresholdPercent: 80,
};

// Pricing constants retained for token-based cost estimation in CostOptimizer.
// Actual billing uses the cost reported by the claude CLI.
const PRICING = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
};

export function calcCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICING.inputPerMillion +
    (outputTokens / 1_000_000) * PRICING.outputPerMillion
  );
}

export function defaultLoopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  const cwd = process.cwd();

  return {
    projectId: `project-${Date.now()}`,
    goal: '',
    targetCoveragePercent: 95,
    maxIterations: 20,
    maxCostUsd: DEFAULT_BUDGET.maxCostUsd,
    maxCriticalIssues: 0,
    workspaceDir: cwd,
    memoryDir: join(cwd, '.goalforge', 'memory'),
    dryRun: false,
    claudeTimeoutMs: 600_000,
    planModel: 'claude-opus-4-8',
    execModel: 'claude-sonnet-4-6',
    ...overrides,
  };
}

