import { createHash } from 'crypto';
import { CostBudget, CostEstimate, TokenUsage } from '../core/types';
import { calcCost } from '../core/config';
import { MemoryStore } from './memory-store';
import { createLogger } from '../core/logger';

/**
 * Tracks cumulative token spend, enforces budget, and provides a hash-keyed
 * response cache so identical prompts never hit the API twice.
 */
export class CostOptimizer {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private directCostUsd = 0;
  private callCount = 0;
  private readonly log = createLogger('CostOptimizer');

  constructor(
    private readonly budget: CostBudget,
    private readonly memory: MemoryStore
  ) {}

  // ── Cache ──────────────────────────────────────────────────────────────────

  /** Deterministic cache key from prompt text + any context strings. */
  buildCacheKey(prompt: string, ...contextParts: string[]): string {
    const raw = [prompt, ...contextParts].join('\n---\n');
    return createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  getCachedResponse(cacheKey: string): string | null {
    const hit = this.memory.getCached(cacheKey);
    // Treat entries that contain no JSON object as stale/corrupt cache misses.
    if (!hit || !hit.includes('{')) return null;
    this.log.debug('Cache hit', { cacheKey: cacheKey.slice(0, 8) + '…' });
    return hit;
  }

  putCachedResponse(cacheKey: string, response: string): void {
    // Only cache responses that actually contain a JSON object.
    if (response && response.includes('{')) {
      this.memory.putCache(cacheKey, response);
    }
  }

  // ── Budget ─────────────────────────────────────────────────────────────────

  /**
   * Call before every LLM request.
   * Returns a CostEstimate that includes a recommendedAction.
   * Callers MUST respect 'skip' — it means the budget is exhausted.
   */
  estimate(
    promptText: string,
    estimatedOutputTokens: number,
    cacheKey: string
  ): CostEstimate {
    const isHit = this.memory.getCached(cacheKey) !== null;

    if (isHit) {
      return {
        cacheKey,
        isCacheHit: true,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        recommendedAction: 'cache-hit',
        reason: 'Response already cached — no API call needed',
      };
    }

    // rough token estimate: 4 chars ≈ 1 token
    const estimatedInput = Math.ceil(promptText.length / 4);
    const estimatedCost = calcCost(estimatedInput, estimatedOutputTokens);
    const currentSpend = this.totalSpend();
    const remainingBudget = this.budget.maxCostUsd - currentSpend;

    if (estimatedCost > remainingBudget) {
      return {
        cacheKey,
        isCacheHit: false,
        inputTokens: estimatedInput,
        outputTokens: estimatedOutputTokens,
        estimatedCostUsd: estimatedCost,
        recommendedAction: 'skip',
        reason: `Budget exhausted — $${currentSpend.toFixed(4)} of $${this.budget.maxCostUsd} spent`,
      };
    }

    const spendPercent = (currentSpend / this.budget.maxCostUsd) * 100;
    if (spendPercent >= this.budget.warnThresholdPercent) {
      this.log.warn('Approaching budget limit', {
        spentUsd: currentSpend.toFixed(4),
        limitUsd: this.budget.maxCostUsd,
        pct: spendPercent.toFixed(1) + '%',
      });
    }

    const action: 'proceed' | 'optimize' =
      estimatedInput > this.budget.maxInputTokensPerCall ? 'optimize' : 'proceed';

    return {
      cacheKey,
      isCacheHit: false,
      inputTokens: estimatedInput,
      outputTokens: estimatedOutputTokens,
      estimatedCostUsd: estimatedCost,
      recommendedAction: action,
      reason:
        action === 'optimize'
          ? `Prompt is large (${estimatedInput} estimated tokens) — consider trimming`
          : 'Within limits — proceed',
    };
  }

  /** Record actual usage after an API call completes (token-based billing). */
  recordUsage(usage: TokenUsage): void {
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.callCount++;
    this.log.debug('Usage recorded', {
      callCount: this.callCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalSpendUsd: this.totalSpend().toFixed(4),
    });
  }

  /** Record cost reported directly by the claude CLI (subscription billing). */
  recordCost(usd: number): void {
    this.directCostUsd += usd;
    this.callCount++;
    this.log.debug('CLI cost recorded', {
      callCount: this.callCount,
      directCostUsd: this.directCostUsd.toFixed(4),
      totalSpendUsd: this.totalSpend().toFixed(4),
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  totalSpend(): number {
    return calcCost(this.totalInputTokens, this.totalOutputTokens) + this.directCostUsd;
  }

  isBudgetExceeded(): boolean {
    return this.totalSpend() >= this.budget.maxCostUsd;
  }

  getStats(): {
    callCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalSpendUsd: number;
    remainingBudgetUsd: number;
    cacheEntries: number;
  } {
    const totalSpendUsd = this.totalSpend();
    return {
      callCount: this.callCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalSpendUsd,
      remainingBudgetUsd: Math.max(0, this.budget.maxCostUsd - totalSpendUsd),
      cacheEntries: this.memory.getCacheSize(),
    };
  }

  /** Sync cumulative totals from a ProjectState so they survive process restarts. */
  restoreFromState(inputTokens: number, outputTokens: number, directCostUsd = 0): void {
    this.totalInputTokens = inputTokens;
    this.totalOutputTokens = outputTokens;
    this.directCostUsd = directCostUsd;
  }
}
