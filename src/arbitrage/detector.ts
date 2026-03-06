import { Token, QuoteResult, ArbitrageOpportunity } from '../types';
import { DexAggregator } from '../dex';
import { estimateFees, calculateProfit } from './calculator';
import { generateId, formatSol, formatPct } from '../utils/helpers';
import { logger } from '../utils/logger';

export interface DetectorConfig {
  tradeAmountSol: number;
  minProfitSol: number;
  maxSlippageBps: number;
  priorityFeeMicroLamports: number;
  jitoTipLamports: number;
}

export class ArbitrageDetector {
  private solPriceUsdc = 150; // cached, updated periodically
  private solPriceUpdatedAt = 0;

  constructor(
    private readonly dex: DexAggregator,
    private readonly cfg: DetectorConfig,
  ) {}

  /** Update cached SOL price */
  async refreshSolPrice(): Promise<void> {
    try {
      const price = await this.dex.getSolPriceUsdc();
      if (price > 0) {
        this.solPriceUsdc = price;
        this.solPriceUpdatedAt = Date.now();
      }
    } catch {
      // keep cached value
    }
  }

  /**
   * Main detection function.
   * 1. Fetch buy quotes (USDC → Token) from all DEXes
   * 2. Find the best buy (most tokens for USDC)
   * 3. Fetch sell quotes (Token → USDC) using the exact buy output amount
   * 4. Find the best sell (most USDC for tokens)
   * 5. Calculate profit and return opportunity if profitable
   */
  async findOpportunity(token: Token): Promise<ArbitrageOpportunity | null> {
    // Refresh SOL price if stale (> 1 minute)
    if (Date.now() - this.solPriceUpdatedAt > 60_000) {
      this.refreshSolPrice().catch(() => {});
    }

    // Step 1: Get buy quotes (SOL → Token) from all DEXes
    const buyQuotes = await this.dex.getBuyQuotes(token, this.cfg.tradeAmountSol);

    if (buyQuotes.length < 2) {
      // Need at least 2 DEXes to compare
      return null;
    }

    // Step 2: Find the best buy quote (most tokens out)
    const bestBuy = buyQuotes.reduce((best, q) =>
      q.outputAmount > best.outputAmount ? q : best,
    );

    // Step 3: Get sell quotes (Token → USDC) using exact buy output amount
    const sellQuotes = await this.dex.getSellQuotes(token, bestBuy.outputAmount);

    if (sellQuotes.length === 0) {
      return null;
    }

    // Step 4: Find best sell quote (most USDC out) — must be a different DEX
    const validSellQuotes = sellQuotes.filter(
      (q) => q.dexName !== bestBuy.dexName,
    );

    if (validSellQuotes.length === 0) {
      // All sell quotes are from the same DEX as the buy — no cross-DEX arb possible
      return null;
    }

    const bestSell = validSellQuotes.reduce((best, q) =>
      q.outputAmount > best.outputAmount ? q : best,
    );

    // Step 5: Estimate fees and calculate profit (SOL)
    const fees = estimateFees(
      this.solPriceUsdc,
      this.cfg.priorityFeeMicroLamports,
      this.cfg.jitoTipLamports,
    );

    const profit = calculateProfit(
      this.cfg.tradeAmountSol,
      bestBuy.outputAmount,
      bestSell.outputAmount,
      fees,
      this.cfg.minProfitSol,
    );

    // Also check price impact isn't too high (> 2% is dangerous)
    if (bestBuy.priceImpactPct > 2 || bestSell.priceImpactPct > 2) {
      logger.debug(`${token.symbol}: skipped — price impact too high`, {
        buyImpact: bestBuy.priceImpactPct,
        sellImpact: bestSell.priceImpactPct,
      });
      return null;
    }

    if (!profit.isProfitable) {
      logger.debug(`${token.symbol}: not profitable`, {
        buy: bestBuy.dexName,
        sell: bestSell.dexName,
        gross: formatSol(profit.grossProfitSol),
        fees: formatSol(profit.feesSol),
        net: formatSol(profit.netProfitSol),
      });
      return null;
    }

    const opportunity: ArbitrageOpportunity = {
      id: generateId(),
      token,
      buyDex: bestBuy.dexName,
      buyDexLabel: bestBuy.jupiterLabel,
      sellDex: bestSell.dexName,
      sellDexLabel: bestSell.jupiterLabel,
      inputAmountSol: this.cfg.tradeAmountSol,
      buyOutputAmount: bestBuy.outputAmount,
      sellOutputSol: profit.sellOutputSol,
      grossProfitSol: profit.grossProfitSol,
      estimatedFeesSol: profit.feesSol,
      netProfitSol: profit.netProfitSol,
      profitPct: profit.profitPct,
      buyQuote: bestBuy.rawResponse,
      sellQuote: bestSell.rawResponse,
      detectedAt: Date.now(),
    };

    logger.info(
      `OPPORTUNITY FOUND: ${token.symbol} | Buy on ${bestBuy.dexName} → Sell on ${bestSell.dexName} | Net profit: ${formatSol(profit.netProfitSol)} (${formatPct(profit.profitPct)})`,
    );

    return opportunity;
  }

  /**
   * Scan a batch of tokens and return the best opportunity (if any).
   */
  async scanBatch(tokens: Token[]): Promise<ArbitrageOpportunity[]> {
    const results = await Promise.allSettled(
      tokens.map((token) => this.findOpportunity(token)),
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<ArbitrageOpportunity> =>
          r.status === 'fulfilled' && r.value !== null,
      )
      .map((r) => r.value)
      .sort((a, b) => b.netProfitSol - a.netProfitSol); // Best profit first
  }
}
