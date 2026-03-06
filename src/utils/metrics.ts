import { BotMetrics, TradeResult } from '../types';
import { logger } from './logger';
import { formatSol } from './helpers';

export class MetricsTracker {
  private metrics: BotMetrics = {
    startTime: Date.now(),
    totalOpportunitiesFound: 0,
    totalTradesExecuted: 0,
    totalTradesSucceeded: 0,
    totalTradesFailed: 0,
    totalProfitSol: 0,
    totalFeesSol: 0,
    totalLossSol: 0,
    consecutiveFailures: 0,
    tokensScanned: 0,
    priceChecksPerformed: 0,
  };

  private _dailyPnl: number = 0;
  private dailyResetAt: number = this.todayMidnight();

  private todayMidnight(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private resetDailyIfNeeded(): void {
    if (Date.now() >= this.dailyResetAt + 86_400_000) {
      this._dailyPnl = 0;
      this.dailyResetAt = this.todayMidnight();
    }
  }

  recordOpportunityFound(): void {
    this.metrics.totalOpportunitiesFound++;
  }

  recordTradeExecuted(): void {
    this.metrics.totalTradesExecuted++;
    this.metrics.lastTradeAt = Date.now();
  }

  recordTradeResult(result: TradeResult): void {
    this.resetDailyIfNeeded();

    if (result.success && result.actualProfitSol !== undefined) {
      this.metrics.totalTradesSucceeded++;
      this.metrics.consecutiveFailures = 0;
      this.metrics.totalProfitSol += result.actualProfitSol;
      this._dailyPnl += result.actualProfitSol;
    } else {
      this.metrics.totalTradesFailed++;
      this.metrics.consecutiveFailures++;
    }
  }

  recordFees(feesSol: number): void {
    this.metrics.totalFeesSol += feesSol;
    this._dailyPnl -= feesSol;
  }

  incrementTokensScanned(n = 1): void {
    this.metrics.tokensScanned += n;
  }

  incrementPriceChecks(n = 1): void {
    this.metrics.priceChecksPerformed += n;
  }

  get consecutiveFailures(): number {
    return this.metrics.consecutiveFailures;
  }

  get dailyLoss(): number {
    return Math.min(0, this._dailyPnl);
  }

  /** Daily P&L in SOL (for dashboard) */
  get dailyPnl(): number {
    return this._dailyPnl;
  }

  get snapshot(): BotMetrics {
    return { ...this.metrics };
  }

  logSummary(): void {
    const elapsed = (Date.now() - this.metrics.startTime) / 1000;
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const netPnl = this.metrics.totalProfitSol - this.metrics.totalFeesSol;

    logger.info('═══════════════════════════════════════════');
    logger.info('  BOT PERFORMANCE SUMMARY');
    logger.info(`  Uptime: ${hours}h ${minutes}m`);
    logger.info(`  Tokens scanned:    ${this.metrics.tokensScanned.toLocaleString()}`);
    logger.info(`  Price checks:      ${this.metrics.priceChecksPerformed.toLocaleString()}`);
    logger.info(`  Opportunities:     ${this.metrics.totalOpportunitiesFound}`);
    logger.info(`  Trades executed:   ${this.metrics.totalTradesExecuted}`);
    logger.info(`  Success / Fail:    ${this.metrics.totalTradesSucceeded} / ${this.metrics.totalTradesFailed}`);
    logger.info(`  Gross profit:      ${formatSol(this.metrics.totalProfitSol)}`);
    logger.info(`  Total fees:        ${formatSol(this.metrics.totalFeesSol)}`);
    logger.info(`  Net P&L:           ${formatSol(netPnl)}`);
    logger.info(`  Daily P&L:         ${formatSol(this._dailyPnl)}`);
    logger.info('═══════════════════════════════════════════');
  }
}
