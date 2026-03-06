// ============================================================
// STATIC CONSTANTS — token mints, program IDs, DEX config
// ============================================================

/** USDC mint on Solana mainnet */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Wrapped SOL mint */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** USDT mint */
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** Jupiter v6 API base */
export const JUPITER_API_BASE = 'https://quote-api.jup.ag/v6';

/** Jupiter price API (v3; v2 is deprecated) */
export const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';
/** CoinGecko fallback for SOL price when Jupiter fails */
export const COINGECKO_SOL_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

/** DexScreener API base */
export const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';

/** Jito block engine endpoints by region */
export const JITO_ENDPOINTS = {
  mainnet: 'https://mainnet.block-engine.jito.wtf',
  amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
  frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
  ny: 'https://ny.mainnet.block-engine.jito.wtf',
  tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
};

/**
 * Jito tip accounts — one is randomly selected per bundle.
 * Source: https://jito-labs.gitbook.io/mev/searcher-resources/tip-accounts
 */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1sTaC4HSbn',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/**
 * Supported DEXes with their Jupiter AMM labels.
 * Only DEXes with consistent liquidity are included.
 */
export const SUPPORTED_DEXES: DexConfig[] = [
  {
    name: 'Orca Whirlpools',
    jupiterLabel: 'Orca V2',
    programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    enabled: true,
  },
  {
    name: 'Raydium AMM',
    jupiterLabel: 'Raydium',
    programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    enabled: true,
  },
  {
    name: 'Raydium CLMM',
    jupiterLabel: 'Raydium CLMM',
    programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    enabled: true,
  },
  {
    name: 'Meteora DLMM',
    jupiterLabel: 'Meteora DLMM',
    programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    enabled: true,
  },
  {
    name: 'Meteora AMM',
    jupiterLabel: 'Meteora',
    programId: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
    enabled: true,
  },
  {
    name: 'Lifinity V2',
    jupiterLabel: 'Lifinity V2',
    programId: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
    enabled: true,
  },
  {
    name: 'Phoenix',
    jupiterLabel: 'Phoenix',
    programId: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
    enabled: true,
  },
];

export interface DexConfig {
  name: string;
  jupiterLabel: string;
  programId: string;
  enabled: boolean;
}

/** Compute unit budget for swap transactions */
export const COMPUTE_UNIT_LIMIT = 200_000;

/** Solana token decimals for common tokens */
export const TOKEN_DECIMALS: Record<string, number> = {
  [USDC_MINT]: 6,
  [WSOL_MINT]: 9,
  [USDT_MINT]: 6,
};

/** Minimum TVL in USD for a DEX pool to be worth checking */
export const MIN_POOL_TVL_USD = 10_000;

/** API rate limits */
export const RATE_LIMITS = {
  dexscreener: { requestsPerMinute: 60, minIntervalMs: 1000 },
  jupiter: { requestsPerMinute: 600, minIntervalMs: 100 },
  birdeye: { requestsPerMinute: 100, minIntervalMs: 600 },
};
