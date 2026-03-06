import { JupiterClient } from './jupiter';
import { QuoteResult, QuoteResultOrError, Token } from '../types';
import { WSOL_MINT } from '../config/constants';
import { solToLamports } from '../utils/helpers';
import { logger } from '../utils/logger';

export { JupiterClient };

export interface DexAggregatorConfig {
  jupiterApiUrl: string;
  slippageBps: number;
  tradeAmountSol: number;
}

/**
 * DexAggregator wraps all DEX integrations. Trading is SOL-based (WSOL).
 */
export class DexAggregator {
  public readonly jupiter: JupiterClient;

  constructor(cfg: DexAggregatorConfig) {
    this.jupiter = new JupiterClient({
      apiUrl: cfg.jupiterApiUrl,
      slippageBps: cfg.slippageBps,
      onlyDirectRoutes: true,
    });
  }

  /**
   * Buy quotes: SOL (WSOL) → Token from every DEX.
   */
  async getBuyQuotes(
    token: Token,
    tradeAmountSol: number,
  ): Promise<QuoteResult[]> {
    const amountLamports = BigInt(solToLamports(tradeAmountSol));
    const allResults: QuoteResultOrError[] = await this.jupiter.getAllDexQuotes(
      WSOL_MINT,
      token.mint,
      amountLamports,
    );

    const successful = allResults.filter((r): r is QuoteResult => r.success);
    logger.debug(`Buy quotes for ${token.symbol}: ${successful.length}/${allResults.length} DEXes responded`);
    return successful;
  }

  /**
   * Sell quotes: Token → SOL (WSOL) from every DEX.
   */
  async getSellQuotes(
    token: Token,
    tokenAmountLamports: bigint,
  ): Promise<QuoteResult[]> {
    const allResults: QuoteResultOrError[] = await this.jupiter.getAllDexQuotes(
      token.mint,
      WSOL_MINT,
      tokenAmountLamports,
    );

    const successful = allResults.filter((r): r is QuoteResult => r.success);
    logger.debug(`Sell quotes for ${token.symbol}: ${successful.length}/${allResults.length} DEXes responded`);
    return successful;
  }

  /**
   * Get the current SOL price in USDC (for display).
   */
  async getSolPriceUsdc(): Promise<number> {
    return this.jupiter.getSolPriceUsdc();
  }
}
