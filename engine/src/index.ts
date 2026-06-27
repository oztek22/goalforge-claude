#!/usr/bin/env node
import { join } from 'path';
import { LoopController } from './loop-controller';
import { defaultLoopConfig } from './core/config';
import { createLogger } from './core/logger';

const VERSION = '1.0.0';

const HELP = `
GoalForge — Describe what you want. Claude builds it. No API key needed.

Usage:
  goalforge <goal>                          Run with a goal
  goalforge --dry-run <goal>                Dry run (no Claude calls)
  goalforge --iter 5 --cost 3 <goal>        Custom limits

Options:
  <goal>                 What to build (required, or set GOAL env var)
  --iter,  -i  <N>       Max loop iterations          (default: 20)
  --cost,  -c  <N>       Max spend cap in USD          (default: 10)
  --cover, -k  <N>       Target line coverage %        (default: 95)
  --id,    -p  <id>      Project ID for resuming       (default: auto)
  --dry-run, -d          Skip Claude calls, write placeholders
  --workspace <path>     Output directory              (default: ./workspace)
  --version, -v          Show version
  --help,    -h          Show this help

Environment variables (overridden by flags):
  GOAL, MAX_ITERATIONS, MAX_COST_USD, TARGET_COVERAGE, PROJECT_ID, DRY_RUN

Examples:
  goalforge "Build a REST API with JWT auth"
  goalforge --iter 3 --cost 2 "Scaffold an Express server"
  goalforge --dry-run "Build a CLI tool"
  goalforge --id my-project "Build a REST API"   # resume existing project
`;

function parseArgs(argv: string[]): {
  goal: string;
  maxIterations: number;
  maxCostUsd: number;
  targetCoverage: number;
  projectId: string;
  dryRun: boolean;
  workspace: string;
} {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`goalforge v${VERSION}\n`);
    process.exit(0);
  }

  let maxIterations = Number(process.env.MAX_ITERATIONS ?? 20);
  let maxCostUsd = Number(process.env.MAX_COST_USD ?? 10);
  let targetCoverage = Number(process.env.TARGET_COVERAGE ?? 95);
  let projectId = process.env.PROJECT_ID ?? `project-${Date.now()}`;
  let dryRun = process.env.DRY_RUN === 'true';
  let workspace = join(process.cwd(), 'workspace');
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--iter': case '-i':      maxIterations = Number(args[++i]); break;
      case '--cost': case '-c':      maxCostUsd = Number(args[++i]); break;
      case '--cover': case '-k':     targetCoverage = Number(args[++i]); break;
      case '--id': case '-p':        projectId = args[++i]; break;
      case '--workspace':            workspace = args[++i]; break;
      case '--dry-run': case '-d':   dryRun = true; break;
      default:
        if (!a.startsWith('-')) positional.push(a);
        else { process.stderr.write(`Unknown flag: ${a}\n${HELP}\n`); process.exit(1); }
    }
  }

  const goal =
    positional.join(' ') ||
    process.env.GOAL ||
    '';

  if (!goal) {
    process.stderr.write('Error: no goal provided.\n\nUsage: goalforge "Build a REST API"\n');
    process.exit(1);
  }

  return { goal, maxIterations, maxCostUsd, targetCoverage, projectId, dryRun, workspace };
}

const log = createLogger('GoalForge');

async function main(): Promise<void> {
  const { goal, maxIterations, maxCostUsd, targetCoverage, projectId, dryRun, workspace } =
    parseArgs(process.argv);

  const config = defaultLoopConfig({
    projectId,
    goal,
    targetCoveragePercent: targetCoverage,
    maxIterations,
    maxCostUsd,
    workspaceDir: workspace,
    memoryDir: join(process.cwd(), '.goalforge', 'memory'),
    dryRun,
  });

  log.info('GoalForge starting', {
    projectId: config.projectId,
    goal: config.goal.slice(0, 80),
    dryRun: config.dryRun,
    maxIterations: config.maxIterations,
    maxCostUsd: config.maxCostUsd,
    workspace: config.workspaceDir,
  });

  const controller = new LoopController(config);

  try {
    const exit = await controller.run();
    log.info('GoalForge complete', {
      reason: exit.reason,
      detail: exit.detail,
      totalCostUsd: exit.finalState.totalCostUsd.toFixed(4),
      iterations: exit.finalState.iterationCount,
      tasksCompleted: exit.finalState.completedTaskIds.length,
    });
    process.exit(0);
  } catch (err) {
    log.error('Fatal error', { err: String(err) });
    process.exit(1);
  }
}

main();
