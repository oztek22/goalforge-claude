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
  const base = join(process.cwd(), '..');

  return {
    projectId: `project-${Date.now()}`,
    goal: '',
    targetCoveragePercent: 95,
    maxIterations: 20,
    maxCostUsd: DEFAULT_BUDGET.maxCostUsd,
    maxCriticalIssues: 0,
    workspaceDir: join(base, 'workspace'),
    memoryDir: join(base, 'engine', 'memory'),
    dryRun: false,
    ...overrides,
  };
}

