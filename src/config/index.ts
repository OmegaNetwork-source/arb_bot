import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseFloat(val);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be a number`);
  return n;
}

export const config = {
  // Wallet
  privateKey: required('PRIVATE_KEY'),

  // RPC — only Helius (or any) RPC URL required
  rpcPrimary: required('RPC_PRIMARY'),
  rpcFallbacks: optional('RPC_FALLBACKS', '').split(',').filter(Boolean),
  heliusApiKey: optional('HELIUS_API_KEY', ''),

  // Jito (default public endpoint; works without extra keys)
  jitoBlockEngineUrl: optional('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
  jitoTipLamports: optionalNumber('JITO_TIP_LAMPORTS', 1_000_000),

  // Trading — SOL-based
  tradeAmountSol: optionalNumber('TRADE_AMOUNT_SOL', 0.1),
  minProfitSol: optionalNumber('MIN_PROFIT_SOL', 0.001),
  maxSlippageBps: optionalNumber('MAX_SLIPPAGE_BPS', 50),
  priorityFeeMicroLamports: optionalNumber('PRIORITY_FEE_MICRO_LAMPORTS', 100_000),
  maxSolPerTradeFees: optionalNumber('MAX_SOL_PER_TRADE_FEES', 0.01),

  // Scanning
  scannerRefreshIntervalMs: optionalNumber('SCANNER_REFRESH_INTERVAL_MS', 30_000),
  priceCheckIntervalMs: optionalNumber('PRICE_CHECK_INTERVAL_MS', 2_000),
  minTokenVolume24h: optionalNumber('MIN_TOKEN_VOLUME_24H', 50_000),
  minPriceChangePct: optionalNumber('MIN_PRICE_CHANGE_PCT', 1.0),
  maxConcurrentChecks: optionalNumber('MAX_CONCURRENT_CHECKS', 10),

  // Risk management (SOL)
  maxConsecutiveFailures: optionalNumber('MAX_CONSECUTIVE_FAILURES', 5),
  dailyLossLimitSol: optionalNumber('DAILY_LOSS_LIMIT_SOL', 0.5),
  tokenCooldownMs: optionalNumber('TOKEN_COOLDOWN_MS', 5_000),

  // APIs (defaults work without keys)
  birdeyeApiKey: optional('BIRDEYE_API_KEY', ''),
  jupiterApiUrl: optional('JUPITER_API_URL', 'https://api.jup.ag/swap/v1'),
  jupiterApiKey: optional('JUPITER_API_KEY', ''),

  // Logging
  logLevel: optional('LOG_LEVEL', 'info'),
  logToFile: optional('LOG_TO_FILE', 'true') === 'true',
  logDir: optional('LOG_DIR', './logs'),

  // Dashboard
  dashboardPort: optionalNumber('DASHBOARD_PORT', 3344),
} as const;

export type Config = typeof config;
