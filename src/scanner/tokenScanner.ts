import { EventEmitter } from 'events';
import { Token, TokenDiscoveryEvent, DexScreenerPair } from '../types';
import {
  getTrendingPairs,
  getTopSolanaTokensByVolume,
  filterByMovement,
  extractTokenMints,
  pairToToken,
  getTokenPairs,
} from './dexscreener';
import { USDC_MINT, WSOL_MINT } from '../config/constants';
import { dedupeBy, sleep } from '../utils/helpers';
import { logger } from '../utils/logger';
import { MetricsTracker } from '../utils/metrics';

// Tokens to skip (stablecoins, WSOL — not useful as arb targets)
const SKIP_MINTS = new Set([
  USDC_MINT,
  WSOL_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // wETH
]);

/**
 * Permanent token watchlist — high-volume tokens checked every cycle
 * regardless of recent price movement.
 */
const PERMANENT_WATCHLIST: Array<{ mint: string; symbol: string }> = [
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP' },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA' },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL' },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL' },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH' },
  { mint: 'jtojtomepa8b1oCEqFpUXLq2mGZhbhmqNkDPo9gv3jT', symbol: 'JTO' },
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, // SOL itself
];

export interface ScannerConfig {
  refreshIntervalMs: number;
  minVolume24h: number;
  minPriceChangePct: number;
}

export class TokenScanner extends EventEmitter {
  private watchlist = new Map<string, Token>(); // mint → Token
  private running = false;
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly cfg: ScannerConfig, private readonly metrics: MetricsTracker) {
    super();
    this.setMaxListeners(20);
    this.initPermanentWatchlist();
  }

  private initPermanentWatchlist(): void {
    for (const { mint, symbol } of PERMANENT_WATCHLIST) {
      if (SKIP_MINTS.has(mint)) continue;
      this.watchlist.set(mint, {
        mint,
        symbol,
        name: symbol,
        decimals: 9,
      });
    }
    logger.info(`Scanner initialized with ${this.watchlist.size} permanent watchlist tokens`);
  }

  /** Start the scanner — emits 'tokens' events with current watchlist */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('Token scanner started');

    // Immediate first refresh
    this.refreshWatchlist().catch((err) =>
      logger.error('Initial watchlist refresh failed', { error: String(err) }),
    );

    // Periodic watchlist refresh
    this.refreshTimer = setInterval(() => {
      this.refreshWatchlist().catch((err) =>
        logger.error('Watchlist refresh failed', { error: String(err) }),
      );
    }, this.cfg.refreshIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    logger.info('Token scanner stopped');
  }

  /** Returns all currently watched token mints */
  getWatchlist(): Token[] {
    return Array.from(this.watchlist.values());
  }

  /** Manually add a token to the watchlist */
  addToken(token: Token): void {
    if (!SKIP_MINTS.has(token.mint)) {
      this.watchlist.set(token.mint, token);
    }
  }

  private async refreshWatchlist(): Promise<void> {
    logger.debug('Refreshing token watchlist from DexScreener...');

    const newTokens: Array<{ token: Token; pairs: DexScreenerPair[]; source: string }> = [];

    // 1. Fetch trending pairs (boosts/trending endpoint)
    try {
      const trendingPairs = await getTrendingPairs();
      const activePairs = filterByMovement(
        trendingPairs,
        this.cfg.minPriceChangePct,
        this.cfg.minVolume24h / 10, // Lower threshold for trending
      );
      const mints = extractTokenMints(activePairs);

      for (const mint of mints) {
        if (SKIP_MINTS.has(mint)) continue;
        const pair = activePairs.find((p) => p.baseToken.address === mint);
        if (!pair) continue;
        const token = pairToToken(pair);
        newTokens.push({ token, pairs: activePairs.filter(p => p.baseToken.address === mint), source: 'trending' });
      }
    } catch (err) {
      logger.debug('Trending fetch failed', { error: String(err) });
    }

    await sleep(500);

    // 2. Fetch top tokens by volume
    try {
      const topPairs = await getTopSolanaTokensByVolume(30);
      const mints = extractTokenMints(topPairs);

      for (const mint of mints) {
        if (SKIP_MINTS.has(mint) || this.watchlist.has(mint)) continue;
        const pair = topPairs.find((p) => p.baseToken.address === mint);
        if (!pair) continue;
        const token = pairToToken(pair);
        newTokens.push({ token, pairs: [pair], source: 'top_volume' });
      }
    } catch (err) {
      logger.debug('Top volume fetch failed', { error: String(err) });
    }

    // 3. Deduplicate and add new tokens to watchlist
    const deduped = dedupeBy(newTokens, (t) => t.token.mint);
    let added = 0;
    for (const { token, pairs, source } of deduped) {
      if (!this.watchlist.has(token.mint)) {
        this.watchlist.set(token.mint, token);
        added++;

        const event: TokenDiscoveryEvent = {
          token,
          triggeredBy: source === 'trending' ? 'dexscreener_trending' : 'dexscreener_top',
          pairs,
          discoveredAt: Date.now(),
        };
        this.emit('newToken', event);
      } else {
        // Update price data
        this.watchlist.set(token.mint, { ...this.watchlist.get(token.mint)!, ...token });
      }
    }

    // Keep watchlist bounded (max 200 tokens)
    if (this.watchlist.size > 200) {
      const toRemove = Array.from(this.watchlist.keys())
        .filter((m) => !PERMANENT_WATCHLIST.some((p) => p.mint === m))
        .slice(0, this.watchlist.size - 200);
      for (const mint of toRemove) this.watchlist.delete(mint);
    }

    this.metrics.incrementTokensScanned(deduped.length);

    logger.info(`Watchlist refreshed: ${this.watchlist.size} tokens tracked, ${added} new added`);
    this.emit('watchlistUpdated', this.getWatchlist());
  }
}
