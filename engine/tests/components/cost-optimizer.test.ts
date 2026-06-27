import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { MemoryStore } from '../../src/components/memory-store';
import { CostOptimizer } from '../../src/components/cost-optimizer';
import { CostBudget } from '../../src/core/types';

const TEST_DIR = join(__dirname, '../../cost-optimizer-test-tmp');

const TEST_BUDGET: CostBudget = {
  maxCostUsd: 1.0,
  maxInputTokensPerCall: 10_000,
  maxOutputTokensPerCall: 2_000,
  warnThresholdPercent: 80,
};

describe('CostOptimizer', () => {
  let memory: MemoryStore;
  let optimizer: CostOptimizer;

  beforeEach(() => {
    memory = new MemoryStore(TEST_DIR);
    optimizer = new CostOptimizer(TEST_BUDGET, memory);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Cache key ──────────────────────────────────────────────────────────────

  it('produces consistent cache keys for identical input', () => {
    const k1 = optimizer.buildCacheKey('hello world', 'ctx1');
    const k2 = optimizer.buildCacheKey('hello world', 'ctx1');
    expect(k1).toBe(k2);
  });

  it('produces different cache keys for different inputs', () => {
    const k1 = optimizer.buildCacheKey('prompt A');
    const k2 = optimizer.buildCacheKey('prompt B');
    expect(k1).not.toBe(k2);
  });

  // ── Cache read/write ───────────────────────────────────────────────────────

  it('returns null on cache miss', () => {
    const key = optimizer.buildCacheKey('uncached');
    expect(optimizer.getCachedResponse(key)).toBeNull();
  });

  it('stores and retrieves cached responses', () => {
    const key = optimizer.buildCacheKey('my prompt');
    optimizer.putCachedResponse(key, 'my response');
    expect(optimizer.getCachedResponse(key)).toBe('my response');
  });

  // ── Estimate: cache hit ────────────────────────────────────────────────────

  it('returns cache-hit action when response is cached', () => {
    const key = optimizer.buildCacheKey('cached prompt');
    optimizer.putCachedResponse(key, 'some response');
    const estimate = optimizer.estimate('cached prompt', 500, key);
    expect(estimate.recommendedAction).toBe('cache-hit');
    expect(estimate.isCacheHit).toBe(true);
    expect(estimate.estimatedCostUsd).toBe(0);
  });

  // ── Estimate: proceed ──────────────────────────────────────────────────────

  it('returns proceed when within budget and token limits', () => {
    const shortPrompt = 'Short prompt';
    const key = optimizer.buildCacheKey(shortPrompt);
    const estimate = optimizer.estimate(shortPrompt, 100, key);
    expect(estimate.recommendedAction).toBe('proceed');
  });

  // ── Estimate: optimize ─────────────────────────────────────────────────────

  it('returns optimize when prompt exceeds per-call token limit', () => {
    // 10_000 token limit at ~4 chars/token = 40_000 char prompt
    const hugPrompt = 'x'.repeat(41_000);
    const key = optimizer.buildCacheKey(hugPrompt);
    const estimate = optimizer.estimate(hugPrompt, 100, key);
    expect(estimate.recommendedAction).toBe('optimize');
  });

  // ── Estimate: skip (budget exceeded) ──────────────────────────────────────

  it('returns skip when remaining budget is insufficient', () => {
    // Exhaust budget via recordUsage
    optimizer.recordUsage({
      inputTokens: 300_000,  // $0.90 at $3/M
      outputTokens: 0,
      estimatedCostUsd: 0,
    });
    // Remaining ≈ $0.10 but next call will exceed
    const bigPrompt = 'a'.repeat(1_000);
    const key = optimizer.buildCacheKey(bigPrompt);
    // Force a cost estimate that exceeds remaining
    optimizer.recordUsage({ inputTokens: 100_000, outputTokens: 0, estimatedCostUsd: 0 });

    const estimate = optimizer.estimate(bigPrompt, 2_000, key);
    // Budget is now $1.20 spent on $1.00 limit → skip
    expect(estimate.recommendedAction).toBe('skip');
  });

  // ── recordUsage ────────────────────────────────────────────────────────────

  it('accumulates token usage across calls', () => {
    optimizer.recordUsage({ inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0 });
    optimizer.recordUsage({ inputTokens: 2000, outputTokens: 1000, estimatedCostUsd: 0 });
    const stats = optimizer.getStats();
    expect(stats.totalInputTokens).toBe(3000);
    expect(stats.totalOutputTokens).toBe(1500);
  });

  it('correctly computes total spend', () => {
    // 1M input tokens @ $3/M = $3, 0 output → $3
    optimizer.recordUsage({ inputTokens: 1_000_000, outputTokens: 0, estimatedCostUsd: 0 });
    expect(optimizer.totalSpend()).toBeCloseTo(3.0, 2);
  });

  // ── isBudgetExceeded ───────────────────────────────────────────────────────

  it('returns false when under budget', () => {
    expect(optimizer.isBudgetExceeded()).toBe(false);
  });

  it('returns true after exceeding budget', () => {
    optimizer.recordUsage({ inputTokens: 1_000_000, outputTokens: 0, estimatedCostUsd: 0 });
    expect(optimizer.isBudgetExceeded()).toBe(true);
  });

  // ── restoreFromState ───────────────────────────────────────────────────────

  it('restores cumulative totals from prior state', () => {
    optimizer.restoreFromState(500_000, 50_000);
    const stats = optimizer.getStats();
    expect(stats.totalInputTokens).toBe(500_000);
    expect(stats.totalOutputTokens).toBe(50_000);
  });

  // ── getStats ───────────────────────────────────────────────────────────────

  it('getStats returns complete stats object', () => {
    const stats = optimizer.getStats();
    expect(stats).toHaveProperty('callCount');
    expect(stats).toHaveProperty('totalSpendUsd');
    expect(stats).toHaveProperty('remainingBudgetUsd');
    expect(stats).toHaveProperty('cacheEntries');
  });
});
