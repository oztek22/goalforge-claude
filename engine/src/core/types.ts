// ─── Task ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'COMPLETE' | 'FAILED';
export type EffortLevel = 'low' | 'medium' | 'high';
export type CritiqueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type CritiqueCategory =
  | 'missing-feature'
  | 'complexity'
  | 'correctness'
  | 'performance'
  | 'security';
export type OptimizerAction = 'proceed' | 'optimize' | 'cache-hit' | 'skip';

export interface PlannerOutput {
  objective: string;
  priority: number;        // 1 = highest
  dependencies: string[];  // task IDs this task depends on
  estimatedEffort: EffortLevel;
  rationale?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface TaskResult {
  output: string;
  filesCreated: string[];
  filesModified: string[];
  commandsRun: string[];
  tokenUsage: TokenUsage;
  executedAt: string;
}

export interface Task extends PlannerOutput {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: TaskResult;
  blockedReason?: string;
  retryCount: number;
}

// ─── Review ──────────────────────────────────────────────────────────────────

export interface Critique {
  id: string;
  taskId: string;
  severity: CritiqueSeverity;
  category: CritiqueCategory;
  description: string;
  suggestion: string;
  createdAt: string;
}

export interface ReviewResult {
  taskId: string;
  passed: boolean;
  score: number;       // 0-100
  critiques: Critique[];
  suggestions: string[];
  reviewedAt: string;
}

// ─── Testing ─────────────────────────────────────────────────────────────────

export interface TestFailure {
  testName: string;
  file: string;
  error: string;
}

export interface TestReport {
  runAt: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  coveragePercent: number;
  failures: TestFailure[];
  rawOutput: string;
}

// ─── Cost ────────────────────────────────────────────────────────────────────

export interface CostEstimate {
  cacheKey: string;
  isCacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  recommendedAction: OptimizerAction;
  reason: string;
}

export interface CostBudget {
  maxCostUsd: number;
  maxInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
  warnThresholdPercent: number;  // warn when this % of budget is spent
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface ArchitectureDecision {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  madeAt: string;
}

export interface ProjectState {
  projectId: string;
  goal: string;
  currentPhase: string;
  iterationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  coveragePercent: number;
  testsPassing: boolean;
  criticalIssueCount: number;
  completedTaskIds: string[];
  failedTaskIds: string[];
  startedAt: string;
  lastUpdatedAt: string;
}

// ─── Loop Controller ─────────────────────────────────────────────────────────

export interface LoopConfig {
  projectId: string;
  goal: string;
  targetCoveragePercent: number;   // default 95
  maxIterations: number;
  maxCostUsd: number;
  maxCriticalIssues: number;       // loop stops if below this
  workspaceDir: string;            // where generated code lives
  memoryDir: string;               // where memory files are stored
  dryRun: boolean;                 // skip real API calls
}

export interface LoopExitReason {
  reason: 'coverage-met' | 'tests-passing' | 'cost-exceeded' | 'no-critical-issues' |
          'max-iterations' | 'all-tasks-complete' | 'fatal-error';
  detail: string;
  finalState: ProjectState;
}
