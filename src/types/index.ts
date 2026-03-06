// ============================================================
// CORE TYPES & INTERFACES
// ============================================================

/** A token on Solana */
export interface Token {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
}

/** A DEX liquidity pair */
export interface DexPair {
  pairAddress: string;
  dexId: string;
  dexName: string;
  baseToken: Token;
  quoteToken: Token;
  priceNative: string;
  priceUsd?: string;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
}

/** Result of a quote request to a specific DEX */
export interface QuoteResult {
  dexName: string;
  jupiterLabel: string;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpactPct: number;
  routePlan: RoutePlan[];
  rawResponse: JupiterQuoteResponse;
  fetchedAt: number;
  success: true;
}

export interface QuoteError {
  dexName: string;
  jupiterLabel: string;
  error: string;
  success: false;
}

export type QuoteResultOrError = QuoteResult | QuoteError;

/** Jupiter v6 quote response */
export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  platformFee: null | { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: RoutePlan[];
  contextSlot: number;
  timeTaken: number;
}

export interface RoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

/** Jupiter swap transaction response */
export interface JupiterSwapResponse {
  swapTransaction: string; // base64
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

/** An identified arbitrage opportunity (SOL-based) */
export interface ArbitrageOpportunity {
  id: string;
  token: Token;
  buyDex: string;
  buyDexLabel: string;
  sellDex: string;
  sellDexLabel: string;
  inputAmountSol: number;        // SOL to spend
  buyOutputAmount: bigint;        // tokens received from buy
  sellOutputSol: number;          // SOL received from sell
  grossProfitSol: number;
  estimatedFeesSol: number;
  netProfitSol: number;
  profitPct: number;
  buyQuote: JupiterQuoteResponse;
  sellQuote: JupiterQuoteResponse;
  detectedAt: number;
}

/** Result of an executed trade */
export interface TradeResult {
  opportunityId: string;
  success: boolean;
  bundleId?: string;
  buyTxSignature?: string;
  sellTxSignature?: string;
  actualProfitSol?: number;
  errorMessage?: string;
  executedAt: number;
  confirmedAt?: number;
}

/** DexScreener pair data */
export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidity?: { usd: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
}

/** DexScreener API response */
export interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

/** Token discovery event emitted by the scanner */
export interface TokenDiscoveryEvent {
  token: Token;
  triggeredBy: 'dexscreener_trending' | 'dexscreener_top' | 'watchlist' | 'onchain';
  pairs: DexScreenerPair[];
  discoveredAt: number;
}

/** Bot performance metrics (SOL-based) */
export interface BotMetrics {
  startTime: number;
  totalOpportunitiesFound: number;
  totalTradesExecuted: number;
  totalTradesSucceeded: number;
  totalTradesFailed: number;
  totalProfitSol: number;
  totalFeesSol: number;
  totalLossSol: number;
  consecutiveFailures: number;
  lastTradeAt?: number;
  tokensScanned: number;
  priceChecksPerformed: number;
}

/** Jito bundle submission response */
export interface JitoBundleResponse {
  jsonrpc: string;
  id: number;
  result?: string; // bundle ID
  error?: { code: number; message: string };
}
