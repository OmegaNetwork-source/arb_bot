/**
 * ============================================================
 * SOLANA ARBITRAGE BOT — MAIN ENTRY POINT
 * ============================================================
 * Architecture:
 *   1. TokenScanner  → discovers tokens with price movement
 *   2. ArbitrageDetector → compares prices across all DEXes
 *   3. Executor      → executes profitable trades via Jito bundles
 * ============================================================
 */

import { config } from './config';
import { initLogger, logger } from './utils/logger';
import { MetricsTracker } from './utils/metrics';
import { loadKeypair, chunk, sleep } from './utils/helpers';
import { TokenScanner } from './scanner/tokenScanner';
import { DexAggregator } from './dex';
import { ArbitrageDetector } from './arbitrage/detector';
import { Executor } from './execution/executor';
import { RpcManager } from './execution/rpcManager';
import { JitoClient } from './execution/jitoClient';
import { Token, ArbitrageOpportunity } from './types';
import * as dashboardState from './dashboard/state';
import { startDashboardServer } from './dashboard/server';
import { SUPPORTED_DEXES, WSOL_MINT } from './config/constants';
import { getTokensDexPrices, getSolPriceFromDexScreener } from './scanner/dexscreener';
import type { TokenDexPriceRow } from './dashboard/state';

// ── Init logging ─────────────────────────────────────────────
initLogger(config.logDir, config.logLevel, config.logToFile);

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════════');
  logger.info('  SOLANA ARBITRAGE BOT  — Starting up...');
  logger.info('═══════════════════════════════════════════════');

  // ── Load wallet ────────────────────────────────────────────
  const wallet = loadKeypair(config.privateKey);
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);

  // ── RPC Manager ────────────────────────────────────────────
  const rpc = new RpcManager([config.rpcPrimary, ...config.rpcFallbacks]);

  // Check wallet SOL balance
  let walletBalanceSol = 0;
  try {
    const balance = await rpc.primary.getBalance(wallet.publicKey);
    walletBalanceSol = balance / 1e9;
    logger.info(`SOL balance: ${walletBalanceSol.toFixed(4)} SOL`);
    if (walletBalanceSol < 0.05) {
      logger.warn('Low SOL balance! Bot needs SOL for transaction fees and Jito tips.');
    }
    dashboardState.setWalletInfo(wallet.publicKey.toBase58(), walletBalanceSol);
  } catch (err) {
    logger.warn('Could not fetch wallet balance', { error: String(err) });
    dashboardState.setWalletInfo(wallet.publicKey.toBase58(), 0);
  }

  // ── Services ────────────────────────────────────────────────
  const metrics = new MetricsTracker();
  const jito = new JitoClient(config.jitoBlockEngineUrl);

  const dexAggregator = new DexAggregator({
    jupiterApiUrl: config.jupiterApiUrl,
    slippageBps: config.maxSlippageBps,
    tradeAmountSol: config.tradeAmountSol,
    jupiterApiKey: config.jupiterApiKey,
  });

  const detector = new ArbitrageDetector(dexAggregator, {
    tradeAmountSol: config.tradeAmountSol,
    minProfitSol: config.minProfitSol,
    maxSlippageBps: config.maxSlippageBps,
    priorityFeeMicroLamports: config.priorityFeeMicroLamports,
    jitoTipLamports: config.jitoTipLamports,
  });

  const executor = new Executor(wallet, dexAggregator.jupiter, jito, rpc, {
    jitoTipLamports: config.jitoTipLamports,
    priorityFeeMicroLamports: config.priorityFeeMicroLamports,
    maxRetries: 2,
    bundleConfirmTimeoutMs: 30_000,
  });

  const scanner = new TokenScanner(
    {
      refreshIntervalMs: config.scannerRefreshIntervalMs,
      minVolume24h: config.minTokenVolume24h,
      minPriceChangePct: config.minPriceChangePct,
    },
    metrics,
  );

  // ── Circuit breaker state ──────────────────────────────────
  let paused = false;
  // Token → timestamp of last trade (cooldown tracking)
  const tokenCooldowns = new Map<string, number>();
  // Token → true when currently being checked (prevent duplicate checks)
  const inFlightChecks = new Set<string>();

  // ── Graceful shutdown ─────────────────────────────────────
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  function shutdown(signal: string): void {
    logger.info(`\n${signal} received — shutting down gracefully...`);
    scanner.stop();
    metrics.logSummary();
    process.exit(0);
  }

  // ── Price scan loop ────────────────────────────────────────
  async function scanForOpportunities(): Promise<void> {
    if (paused) return;

    const tokens = scanner.getWatchlist().filter((t) => {
      // Skip tokens in cooldown
      const cooldownUntil = tokenCooldowns.get(t.mint) ?? 0;
      if (Date.now() < cooldownUntil) return false;
      // Skip tokens currently being checked
      if (inFlightChecks.has(t.mint)) return false;
      return true;
    });

    if (tokens.length === 0) return;

    metrics.incrementTokensScanned(tokens.length);

    // Process tokens in concurrent batches
    const batches = chunk(tokens, config.maxConcurrentChecks);

    for (const batch of batches) {
      if (paused) break;

      // Mark all as in-flight
      batch.forEach((t) => inFlightChecks.add(t.mint));

      try {
        const opportunities = await detector.scanBatch(batch);
        metrics.incrementPriceChecks(batch.length);

        for (const opp of opportunities) {
          await handleOpportunity(opp);
          if (paused) break;
        }
      } catch (err) {
        logger.error('Batch scan error', { error: String(err) });
      } finally {
        batch.forEach((t) => inFlightChecks.delete(t.mint));
      }
    }
  }

  // ── Opportunity handler ───────────────────────────────────
  async function handleOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    metrics.recordOpportunityFound();
    dashboardState.pushOpportunity(opp);

    // Circuit breaker check
    if (metrics.consecutiveFailures >= config.maxConsecutiveFailures) {
      if (!paused) {
        paused = true;
        dashboardState.setPaused(true);
        logger.error(
          `Circuit breaker tripped: ${config.maxConsecutiveFailures} consecutive failures. Pausing for 60s.`,
        );
        setTimeout(() => {
          paused = false;
          dashboardState.setPaused(false);
          logger.info('Circuit breaker reset — resuming.');
        }, 60_000);
      }
      return;
    }

    // Daily loss limit check (SOL)
    if (Math.abs(metrics.dailyLoss) >= config.dailyLossLimitSol) {
      logger.error('Daily loss limit reached. Stopping bot.');
      shutdown('DAILY_LOSS_LIMIT');
      return;
    }

    // Apply cooldown for this token
    tokenCooldowns.set(opp.token.mint, Date.now() + config.tokenCooldownMs);

    metrics.recordTradeExecuted();

    const result = await executor.execute(opp);
    metrics.recordTradeResult(result);
    dashboardState.pushTrade(result, opp.token.symbol);
    dashboardState.setMetrics(metrics.snapshot, metrics.dailyPnl);

    if (result.success) {
      logger.info(`Trade SUCCESS | Profit: ~${result.actualProfitSol?.toFixed(6)} SOL`, {
        bundleId: result.bundleId,
        token: opp.token.symbol,
      });
    } else {
      logger.warn(`Trade FAILED | ${result.errorMessage}`, {
        opportunityId: opp.id,
        token: opp.token.symbol,
      });
    }
  }

  // ── Dashboard ──────────────────────────────────────────────
  startDashboardServer(config.dashboardPort);

  /** Refresh token-vs-DEX prices from DexScreener pair data (no Jupiter rate limits) */
  const DASHBOARD_PRICE_REFRESH_MS = 60_000;

  async function refreshDashboardTokenPrices(): Promise<void> {
    const tokens = scanner.getWatchlist();
    if (tokens.length === 0) return;

    const mints = tokens.map((t) => t.mint);
    let dexPriceMap: Map<string, Map<string, number>>;
    try {
      dexPriceMap = await getTokensDexPrices(mints);
    } catch (err) {
      logger.warn('Dashboard price refresh failed', { error: String(err) });
      return;
    }

    const rows: TokenDexPriceRow[] = [];
    for (const token of tokens) {
      const pricesByDex = dexPriceMap.get(token.mint) ?? new Map<string, number>();
      const prices: { dexId: string; priceUsd: number }[] = [];

      for (const [dexName, priceUsd] of pricesByDex) {
        prices.push({ dexId: dexName, priceUsd });
      }

      const usds = prices.map((p) => p.priceUsd);
      const minPriceUsd = usds.length ? Math.min(...usds) : 0;
      const maxPriceUsd = usds.length ? Math.max(...usds) : 0;
      const spreadPct = minPriceUsd > 0 ? ((maxPriceUsd - minPriceUsd) / minPriceUsd) * 100 : 0;
      const status: TokenDexPriceRow['status'] =
        spreadPct >= 2 ? 'Arb' : spreadPct >= 0.5 ? 'Spread' : '—';

      rows.push({ token, prices, minPriceUsd, maxPriceUsd, spreadPct, status });
    }

    dashboardState.setTokenDexPrices(rows);
    const totalPrices = rows.reduce((n, r) => n + r.prices.length, 0);
    logger.info(`Dashboard: DexScreener prices for ${rows.length} tokens, ${totalPrices} DEX price points`);
  }

  // ── Start everything ──────────────────────────────────────
  scanner.start();

  // Warm up SOL price (CoinGecko → Jupiter → DexScreener → $150 fallback)
  await detector.refreshSolPrice();
  let solPrice = await dexAggregator.getSolPriceUsdc();
  if (solPrice === 150) {
    const dsPrice = await getSolPriceFromDexScreener();
    if (dsPrice) solPrice = dsPrice;
  }
  dashboardState.setSolPriceUsd(solPrice);
  logger.info(`Initial SOL price: $${solPrice.toFixed(2)}`);

  // Main scan loop
  logger.info(`Starting price scan loop (interval: ${config.priceCheckIntervalMs}ms)`);
  logger.info(
    `Trade config: ${config.tradeAmountSol} SOL/trade | min profit: ${config.minProfitSol} SOL | max slippage: ${config.maxSlippageBps}bps`,
  );

  setInterval(scanForOpportunities, config.priceCheckIntervalMs);

  // Update dashboard: watchlist + metrics every 30s
  setInterval(() => {
    dashboardState.setWatchlist(scanner.getWatchlist());
    dashboardState.setMetrics(metrics.snapshot, metrics.dailyPnl);
  }, 30_000);

  // Periodic metrics summary (every 5 minutes)
  setInterval(() => metrics.logSummary(), 5 * 60 * 1000);

  // Refresh SOL price every 2 minutes (CoinGecko → Jupiter → DexScreener → $150 fallback)
  setInterval(async () => {
    await detector.refreshSolPrice();
    let price = await dexAggregator.getSolPriceUsdc();
    if (price === 150) {
      const dsPrice = await getSolPriceFromDexScreener();
      if (dsPrice) price = dsPrice;
    }
    dashboardState.setSolPriceUsd(price);
  }, 2 * 60 * 1000);

  // Dashboard token-vs-DEX prices from DexScreener (fast batch, no rate limit issues)
  setTimeout(() => refreshDashboardTokenPrices(), 5_000);
  setInterval(refreshDashboardTokenPrices, DASHBOARD_PRICE_REFRESH_MS);

  logger.info('Bot is running. Press Ctrl+C to stop.');
  // Dashboard URL is logged by startDashboardServer (may use next port if 3344 is in use)
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
