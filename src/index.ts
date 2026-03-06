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

  /** Refresh token-vs-DEX prices from Jupiter (so dashboard has full DEX coverage) */
  const DASHBOARD_PRICE_REFRESH_MS = 90_000;
  const QUOTE_AMOUNT_SOL = 0.01;
  const QUOTE_AMOUNT_LAMPORTS = BigInt(Math.round(QUOTE_AMOUNT_SOL * 1e9));

  async function refreshDashboardTokenPrices(): Promise<void> {
    const tokens = scanner.getWatchlist();
    if (tokens.length === 0) return;
    let solPriceUsd: number;
    try {
      solPriceUsd = await dexAggregator.getSolPriceUsdc();
    } catch {
      return;
    }
    const enabledDexes = SUPPORTED_DEXES.filter((d) => d.enabled);
    const rows: TokenDexPriceRow[] = [];
    // One token at a time to avoid Jupiter rate limits; 7 DEX quotes in parallel per token
    for (const token of tokens) {
      const prices: { dexId: string; priceUsd: number }[] = [];
      const decimals = token.decimals ?? 6;

      const quotePromises = enabledDexes.map(async (dex) => {
        const quote = await dexAggregator.jupiter.getQuote(
          WSOL_MINT,
          token.mint,
          QUOTE_AMOUNT_LAMPORTS,
          dex.jupiterLabel,
          false, // allow multi-hop routes for dashboard display
        );
        if (quote?.outAmount && BigInt(quote.outAmount) > 0n) {
          const outAmount = Number(quote.outAmount);
          const tokenAmountHuman = outAmount / Math.pow(10, decimals);
          if (tokenAmountHuman > 0) {
            const inputUsd = QUOTE_AMOUNT_SOL * solPriceUsd;
            const priceUsd = inputUsd / tokenAmountHuman;
            prices.push({ dexId: dex.name, priceUsd });
          }
        }
      });

      await Promise.all(quotePromises);

      const usds = prices.map((p) => p.priceUsd);
      const minPriceUsd = usds.length ? Math.min(...usds) : 0;
      const maxPriceUsd = usds.length ? Math.max(...usds) : 0;
      const spreadPct = minPriceUsd > 0 ? ((maxPriceUsd - minPriceUsd) / minPriceUsd) * 100 : 0;
      const status: TokenDexPriceRow['status'] =
        spreadPct >= 2 ? 'Arb' : spreadPct >= 0.5 ? 'Spread' : '—';

      rows.push({
        token,
        prices,
        minPriceUsd,
        maxPriceUsd,
        spreadPct,
        status,
      });
      await sleep(300);
    }

    dashboardState.setTokenDexPrices(rows);
    const totalPrices = rows.reduce((n, r) => n + r.prices.length, 0);
    logger.info(`Dashboard: Jupiter prices for ${rows.length} tokens, ${totalPrices} DEX quotes`);
  }

  // ── Start everything ──────────────────────────────────────
  scanner.start();

  // Warm up SOL price
  await detector.refreshSolPrice();
  const solPrice = await dexAggregator.getSolPriceUsdc();
  dashboardState.setSolPriceUsd(solPrice);
  logger.info('Initial SOL price fetched');

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

  // Refresh SOL price every 2 minutes and update dashboard
  setInterval(async () => {
    await detector.refreshSolPrice();
    const price = await dexAggregator.getSolPriceUsdc();
    dashboardState.setSolPriceUsd(price);
  }, 2 * 60 * 1000);

  // Dashboard token-vs-DEX prices from Jupiter (full DEX list, quote-based)
  setTimeout(() => refreshDashboardTokenPrices(), 45_000);
  setInterval(refreshDashboardTokenPrices, DASHBOARD_PRICE_REFRESH_MS);

  logger.info('Bot is running. Press Ctrl+C to stop.');
  // Dashboard URL is logged by startDashboardServer (may use next port if 3344 is in use)
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
