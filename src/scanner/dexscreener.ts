import axios from 'axios';
import axiosRetry from 'axios-retry';
import { DexScreenerPair, DexScreenerResponse } from '../types';
import { DEXSCREENER_API_BASE } from '../config/constants';
import { logger } from '../utils/logger';
import { chunk, sleep } from '../utils/helpers';

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const client = axios.create({
  baseURL: DEXSCREENER_API_BASE,
  timeout: 10_000,
  headers: { Accept: 'application/json' },
});

/** Fetch trending/boosted Solana token pairs */
export async function getTrendingPairs(): Promise<DexScreenerPair[]> {
  try {
    // Use the token-boosts endpoint for trending tokens
    const resp = await client.get('/token-boosts/top/v1');
    const boosts: Array<{ chainId: string; tokenAddress: string }> = resp.data ?? [];

    const solanaMints = boosts
      .filter((b) => b.chainId === 'solana')
      .map((b) => b.tokenAddress)
      .slice(0, 20);

    if (solanaMints.length === 0) return [];

    return await getTokenPairs(solanaMints);
  } catch (err) {
    logger.debug('getTrendingPairs failed, using search fallback', { error: String(err) });
    return await searchSolanaPairs();
  }
}

/** Search for active Solana pairs */
async function searchSolanaPairs(): Promise<DexScreenerPair[]> {
  const resp = await client.get<DexScreenerResponse>('/latest/dex/search', {
    params: { q: 'solana' },
  });
  return (resp.data?.pairs ?? []).filter((p) => p.chainId === 'solana');
}

/** Fetch all DEX pairs for a list of token mint addresses */
export async function getTokenPairs(mints: string[]): Promise<DexScreenerPair[]> {
  const results: DexScreenerPair[] = [];
  // DexScreener supports up to 30 tokens per request
  const batches = chunk(mints, 30);

  for (const batch of batches) {
    try {
      const resp = await client.get<DexScreenerResponse>(
        `/latest/dex/tokens/${batch.join(',')}`,
      );
      const pairs = resp.data?.pairs ?? [];
      results.push(...pairs.filter((p) => p.chainId === 'solana'));
    } catch (err) {
      logger.debug('getTokenPairs batch failed', { batch: batch.slice(0, 3), error: String(err) });
    }
    if (batches.length > 1) await sleep(300); // rate limiting
  }

  return results;
}

/** Fetch top Solana tokens by volume using DexScreener search */
export async function getTopSolanaTokensByVolume(limit = 50): Promise<DexScreenerPair[]> {
  try {
    const queries = ['SOL', 'USDC', 'JUP', 'RAY', 'BONK', 'WIF', 'PYTH', 'JTO', 'ORCA', 'MSOL'];
    const allPairs: DexScreenerPair[] = [];

    for (const q of queries.slice(0, 5)) {
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
      .filter((p) => (p.volume?.h24 ?? 0) > 10_000)
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
