import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import {
  JupiterQuoteResponse,
  JupiterSwapResponse,
  QuoteResult,
  QuoteError,
  QuoteResultOrError,
} from '../types';
import { SUPPORTED_DEXES, JUPITER_PRICE_API, WSOL_MINT, COINGECKO_SOL_PRICE_URL } from '../config/constants';
import { logger } from '../utils/logger';

export interface JupiterClientConfig {
  apiUrl: string;
  slippageBps: number;
  onlyDirectRoutes?: boolean;
  apiKey?: string;
}

export class JupiterClient {
  private client: AxiosInstance;
  private priceClient: AxiosInstance;
  /** Enforces Jupiter free-tier limit of 1 request/second */
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;

  constructor(private readonly cfg: JupiterClientConfig) {
    // Free tier = 1 RPS; paid tier can push this lower (e.g. 50ms = 20 RPS)
    this.minIntervalMs = cfg.apiKey ? 100 : 1_100;
    const authHeaders = cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {};

    this.client = axios.create({
      baseURL: cfg.apiUrl,
      timeout: 15_000,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
    });

    this.priceClient = axios.create({
      baseURL: JUPITER_PRICE_API,
      timeout: 10_000,
      headers: { ...authHeaders },
    });

    axiosRetry(this.client, {
      retries: 2,
      retryDelay: (count) => count * 300,
      retryCondition: (err) => !err.response || err.response.status >= 500,
    });
  }

  /** Wait until the minimum inter-request interval has passed */
  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /**
   * Get a quote from a specific DEX (or all DEXes if jupiterLabel is undefined).
   * Uses Jupiter's /quote endpoint with the `dexes` filter.
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    jupiterLabel?: string,
    onlyDirectRoutesOverride?: boolean,
  ): Promise<JupiterQuoteResponse | null> {
    const params: Record<string, string | number | boolean> = {
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: this.cfg.slippageBps,
      onlyDirectRoutes: onlyDirectRoutesOverride ?? this.cfg.onlyDirectRoutes ?? true,
    };

    if (jupiterLabel) {
      // Pass the label as-is; axios will percent-encode spaces to %20 correctly
      params.dexes = jupiterLabel;
    }

    await this.throttle();
    try {
      const resp = await this.client.get<JupiterQuoteResponse>('/quote', { params });
      return resp.data;
    } catch (err: any) {
      if (err.response?.status === 400) {
        // No route found — normal for some DEX/token combos
        return null;
      }
      logger.debug('Jupiter quote failed', {
        dex: jupiterLabel ?? 'all',
        inputMint,
        outputMint,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Get quotes from ALL supported DEXes simultaneously for a given token pair.
   * Returns an array of QuoteResult | QuoteError for each DEX.
   */
  async getAllDexQuotes(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    onlyDirectRoutesOverride?: boolean,
  ): Promise<QuoteResultOrError[]> {
    const enabledDexes = SUPPORTED_DEXES.filter((d) => d.enabled);

    const results = await Promise.allSettled(
      enabledDexes.map(async (dex): Promise<QuoteResultOrError> => {
        const quote = await this.getQuote(inputMint, outputMint, amount, dex.jupiterLabel, onlyDirectRoutesOverride);

        if (!quote || !quote.outAmount || BigInt(quote.outAmount) === 0n) {
          return {
            dexName: dex.name,
            jupiterLabel: dex.jupiterLabel,
            error: 'No route or zero output',
            success: false,
          } satisfies QuoteError;
        }

        return {
          dexName: dex.name,
          jupiterLabel: dex.jupiterLabel,
          inputMint,
          outputMint,
          inputAmount: amount,
          outputAmount: BigInt(quote.outAmount),
          priceImpactPct: parseFloat(quote.priceImpactPct),
          routePlan: quote.routePlan,
          rawResponse: quote,
          fetchedAt: Date.now(),
          success: true,
        } satisfies QuoteResult;
      }),
    );

    return results.map((r, i): QuoteResultOrError => {
      if (r.status === 'fulfilled') return r.value;
      return {
        dexName: enabledDexes[i].name,
        jupiterLabel: enabledDexes[i].jupiterLabel,
        error: String(r.reason),
        success: false,
      };
    });
  }

  /**
   * Get a swap transaction for a given quote.
   * Returns base64-encoded versioned transaction.
   */
  async getSwapTransaction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string,
    priorityFeeMicroLamports: number,
  ): Promise<JupiterSwapResponse | null> {
    try {
      const resp = await this.client.post<JupiterSwapResponse>('/swap', {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          jitoTipLamports: undefined, // We handle Jito tips separately
        },
        computeUnitPriceMicroLamports: priorityFeeMicroLamports,
        asLegacyTransaction: false,
      });
      return resp.data;
    } catch (err: any) {
      logger.error('Jupiter swap transaction failed', {
        error: err.message,
        quoteInputMint: quoteResponse.inputMint,
        quoteOutputMint: quoteResponse.outputMint,
      });
      return null;
    }
  }

  /**
   * Get current SOL price in USD. Tries CoinGecko first (no key, reliable), then Jupiter, then fallback.
   */
  async getSolPriceUsdc(): Promise<number> {
    // 1. CoinGecko first (no auth, stable) — use axios directly with full URL
    try {
      const cg = await axios.get<{ solana?: { usd?: number } }>(COINGECKO_SOL_PRICE_URL, {
        timeout: 8_000,
      });
      const price = cg.data?.solana?.usd;
      if (price != null && price > 0) return price;
    } catch {
      // continue
    }
    // 2. Jupiter Price API v3 — response shape: {data: {[mint]: {price: "145.23"}}}
    try {
      const resp = await this.priceClient.get<{ data?: Record<string, { price?: string }> }>('', {
        params: { ids: WSOL_MINT },
      });
      const raw = resp.data?.data?.[WSOL_MINT]?.price;
      const price = raw != null ? parseFloat(raw) : NaN;
      if (!isNaN(price) && price > 0) return price;
    } catch {
      // ignore
    }
    return 150; // last-resort fallback
  }

  /**
   * Get token price in USD via Jupiter Price API v3.
   * Response format: { [mint]: { usdPrice: number, decimals: number, ... } }
   */
  async getTokenPriceUsdc(mint: string): Promise<number | null> {
    try {
      const resp = await this.priceClient.get<{ data?: Record<string, { price?: string }> }>('', {
        params: { ids: mint },
      });
      const raw = resp.data?.data?.[mint]?.price;
      const price = raw != null ? parseFloat(raw) : NaN;
      return !isNaN(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }
}
