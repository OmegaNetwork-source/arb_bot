import axios from 'axios';
import axiosRetry from 'axios-retry';
import { DexScreenerPair, DexScreenerResponse } from '../types';
import { DEXSCREENER_API_BASE, WSOL_MINT, USDC_MINT } from '../config/constants';
import { logger } from '../utils/logger';
import { chunk, sleep } from '../utils/helpers';

/**
 * Known DexScreener dexId → display name overrides.
 * Any dexId NOT in this map is still shown; we just auto-format the raw id.
 */
const DEXSCREENER_ID_TO_NAME: Record<string, string> = {
  orca:                'Orca Whirlpools',
  raydium:             'Raydium AMM',
  'raydium-clmm':      'Raydium CLMM',
  'meteora-dlmm':      'Meteora DLMM',
  meteora:             'Meteora AMM',
  'lifinity-v2':       'Lifinity V2',
  lifinity:            'Lifinity V2',
  phoenix:             'Phoenix',
  'orca-whirlpool':    'Orca Whirlpools',
  'raydium-amm':       'Raydium AMM',
  'meteora-amm':       'Meteora AMM',
  'pump-fun-amm':      'Pump AMM',
  'pump.fun':          'Pump AMM',
  pumpfun:             'Pump AMM',
  'fluxbeam':          'FluxBeam',
  'saber':             'Saber',
  'aldrin':            'Aldrin',
  'crema':             'Crema',
  'invariant':         'Invariant',
  'dradex':            'DraDEX',
  'openbook':          'OpenBook',
  'openbook-v2':       'OpenBook V2',
};

/** Convert a raw DexScreener dexId to a human-readable display label */
function dexIdToDisplayName(dexId: string): string {
  return (
    DEXSCREENER_ID_TO_NAME[dexId] ??
    dexId
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

/** Quote tokens we accept for clean USD pricing */
const VALID_QUOTE_SYMBOLS = new Set(['SOL', 'USDC', 'USDT', 'WSOL']);
const VALID_QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT]);

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const client = axios.create({
  baseURL: DEXSCREENER_API_BASE,
  timeout: 10_000,
  headers: { Accept: 'application/json' },
});

/**
 * Fetch high-volume Solana token pairs using DexScreener search.
 * Deliberately avoids the /token-boosts endpoint which returns paid-promoted
 * meme coins regardless of legitimacy.
 */
export async function getTrendingPairs(): Promise<DexScreenerPair[]> {
  // Use volume-based search across a broader set of query terms
  const queries = ['BONK', 'WIF', 'BOME', 'TRUMP', 'FARTCOIN', 'MEW', 'POPCAT', 'PNUT', 'AI16Z', 'GRIFFAIN'];
  const allPairs: DexScreenerPair[] = [];

  for (const q of queries) {
    try {
      const resp = await client.get<DexScreenerResponse>('/latest/dex/search', {
        params: { q },
      });
      const pairs = (resp.data?.pairs ?? []).filter((p) => p.chainId === 'solana');
      allPairs.push(...pairs);
    } catch {
      // continue
    }
    await sleep(200);
  }

  return allPairs
    .filter((p) => (p.volume?.h24 ?? 0) >= 50_000 && (p.liquidity?.usd ?? 0) >= 20_000)
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .slice(0, 40);
}

/** Search for active Solana pairs */
async function searchSolanaPairs(): Promise<DexScreenerPair[]> {
  const resp = await client.get<DexScreenerResponse>('/latest/dex/search', {
    params: { q: 'solana' },
  });
  return (resp.data?.pairs ?? []).filter((p) => p.chainId === 'solana');
}

/**
 * Fetch all DEX pairs for a list of token mint addresses.
 * Uses the v1 endpoint (300 req/min, returns array directly).
 */
export async function getTokenPairs(mints: string[]): Promise<DexScreenerPair[]> {
  const results: DexScreenerPair[] = [];
  // Up to 30 tokens per request
  const batches = chunk(mints, 30);

  for (const batch of batches) {
    try {
      // v1 endpoint: returns array directly (not wrapped in {pairs: []})
      const resp = await client.get<DexScreenerPair[]>(
        `/tokens/v1/solana/${batch.join(',')}`,
      );
      const pairs = Array.isArray(resp.data) ? resp.data : [];
      results.push(...pairs);
    } catch (err) {
      logger.debug('getTokenPairs v1 batch failed, falling back', {
        batch: batch.slice(0, 3),
        error: String(err),
      });
      // Fallback to legacy endpoint
      try {
        const resp = await client.get<DexScreenerResponse>(
          `/latest/dex/tokens/${batch.join(',')}`,
        );
        const pairs = resp.data?.pairs ?? [];
        results.push(...pairs.filter((p) => p.chainId === 'solana'));
      } catch {
        // continue
      }
    }
    if (batches.length > 1) await sleep(200);
  }

  return results;
}

/** Fetch top Solana tokens by volume using DexScreener search */
export async function getTopSolanaTokensByVolume(limit = 50): Promise<DexScreenerPair[]> {
  try {
    const queries = [
      'SOL', 'JUP', 'RAY', 'BONK', 'WIF', 'PYTH', 'JTO', 'ORCA', 'MSOL',
      'RENDER', 'HNT', 'MOBILE', 'IOT', 'MNGO', 'STEP', 'SAMO', 'COPE',
      'ATLAS', 'POLIS', 'SRM', 'FIDA', 'SLND', 'PORT', 'TULIP',
    ];
    const allPairs: DexScreenerPair[] = [];

    for (const q of queries) {
      try {
        const resp = await client.get<DexScreenerResponse>('/latest/dex/search', {
          params: { q },
        });
        const pairs = (resp.data?.pairs ?? []).filter((p) => p.chainId === 'solana');
        allPairs.push(...pairs);
      } catch {
        // continue
      }
      await sleep(200);
    }

    return allPairs
      .filter((p) => (p.volume?.h24 ?? 0) >= 50_000 && (p.liquidity?.usd ?? 0) >= 10_000)
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
      .slice(0, limit);
  } catch (err) {
    logger.warn('getTopSolanaTokensByVolume failed', { error: String(err) });
    return [];
  }
}

/** Filter pairs that have significant price movement */
export function filterByMovement(
  pairs: DexScreenerPair[],
  minPriceChangePct: number,
  minVolume24h: number,
): DexScreenerPair[] {
  return pairs.filter((p) => {
    const vol = p.volume?.h24 ?? 0;
    const change5m = Math.abs(p.priceChange?.m5 ?? 0);
    const change1h = Math.abs(p.priceChange?.h1 ?? 0);
    const liquidity = p.liquidity?.usd ?? 0;

    return (
      vol >= minVolume24h &&
      liquidity >= 5_000 &&
      (change5m >= minPriceChangePct || change1h >= minPriceChangePct * 2)
    );
  });
}

/** Extract unique token mints from a list of pairs (base tokens only) */
export function extractTokenMints(pairs: DexScreenerPair[]): string[] {
  const mints = new Set<string>();
  for (const pair of pairs) {
    mints.add(pair.baseToken.address);
  }
  return Array.from(mints);
}

/** Build a Token object from a DexScreenerPair */
export function pairToToken(pair: DexScreenerPair) {
  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    decimals: 6, // Will be refined by Jupiter price API
    priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : undefined,
    volume24hUsd: pair.volume?.h24,
  };
}

export interface PoolPrice {
  priceUsd: number;
  liquidityUsd: number;
}

/**
 * Batch-fetch per-DEX prices for a list of token mints from DexScreener.
 * No Jupiter API calls required — uses DexScreener pair data directly.
 *
 * Returns: mint → (dexDisplayName → PoolPrice)
 *
 * Rules:
 *  - Quote token must be SOL, USDC, or USDT (for clean USD pricing)
 *  - Only pools with at least `minLiquidityUsd` (default $10K for display)
 *  - Unknown dexIds are auto-formatted (never silently dropped)
 *  - When a token has multiple pools on the same DEX, highest-liquidity wins
 */
export async function getTokensDexPrices(
  mints: string[],
  minLiquidityUsd = 10_000,
): Promise<Map<string, Map<string, PoolPrice>>> {
  const result = new Map<string, Map<string, PoolPrice>>();

  const pairs = await getTokenPairs(mints);

  // Log unknown dexIds in debug mode so we can extend the mapping
  const unknownDexIds = new Set<string>();

  for (const pair of pairs) {
    if (!pair.priceUsd) continue;

    const liquidity = pair.liquidity?.usd ?? 0;
    if (liquidity < minLiquidityUsd) continue;

    // Accept SOL, USDC, or USDT quote tokens
    const quoteAddr = pair.quoteToken.address;
    const quoteSymbol = pair.quoteToken.symbol?.toUpperCase() ?? '';
    const isRelevantQuote =
      VALID_QUOTE_MINTS.has(quoteAddr) ||
      VALID_QUOTE_SYMBOLS.has(quoteSymbol);
    if (!isRelevantQuote) continue;

    if (!DEXSCREENER_ID_TO_NAME[pair.dexId]) unknownDexIds.add(pair.dexId);
    const dexName = dexIdToDisplayName(pair.dexId);

    const mint = pair.baseToken.address;
    if (!result.has(mint)) result.set(mint, new Map());

    const dexPrices = result.get(mint)!;
    const existing = dexPrices.get(dexName);

    // Keep the highest-liquidity pool per DEX
    if (!existing || liquidity > existing.liquidityUsd) {
      dexPrices.set(dexName, { priceUsd: parseFloat(pair.priceUsd), liquidityUsd: liquidity });
    }
  }

  if (unknownDexIds.size > 0) {
    logger.debug('DexScreener: unmapped dexIds (auto-formatted)', {
      ids: Array.from(unknownDexIds),
    });
  }

  return result;
}

/**
 * Get current SOL price in USD from DexScreener (SOL/USDC pair).
 * Used as a fallback when CoinGecko / Jupiter price APIs are unavailable.
 */
export async function getSolPriceFromDexScreener(): Promise<number | null> {
  try {
    const pairs = await getTokenPairs([WSOL_MINT]);
    // Find the highest-liquidity SOL/USDC pair
    const solUsdcPairs = pairs.filter(
      (p) =>
        p.quoteToken.address === USDC_MINT &&
        p.priceUsd &&
        (p.liquidity?.usd ?? 0) > 100_000,
    );
    if (solUsdcPairs.length === 0) return null;
    solUsdcPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return parseFloat(solUsdcPairs[0].priceUsd!);
  } catch {
    return null;
  }
}
