/**
 * In-memory state for the dashboard. Updated by the main bot; read by the HTTP server.
 */
import { ArbitrageOpportunity, TradeResult, Token, BotMetrics } from '../types';

const MAX_RECENT = 100;

/** Price on a single DEX (from DexScreener) */
export interface DexPrice {
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
}

/** One row for the token-vs-DEX price table */
export interface TokenDexPriceRow {
  token: Token;
  prices: DexPrice[];
  minPriceUsd: number;
  maxPriceUsd: number;
  spreadPct: number;
  status: 'Arb' | 'Spread' | '—';
}

export interface DashboardState {
  walletAddress: string | null;
  walletBalanceSol: number | null;
  solPriceUsd: number | null;
  dailyPnl: number | null;
  paused: boolean;
  lastUpdated: number;
  metrics: BotMetrics | null;
  watchlist: Token[];
  /** Token prices per DEX for dashboard table */
  tokenDexPrices: TokenDexPriceRow[];
  recentOpportunities: ArbitrageOpportunity[];
  recentTrades: (TradeResult & { tokenSymbol?: string })[];
}

const state: DashboardState = {
  walletAddress: null,
  walletBalanceSol: null,
  solPriceUsd: null,
  dailyPnl: null,
  paused: false,
  lastUpdated: 0,
  metrics: null,
  watchlist: [],
  tokenDexPrices: [],
  recentOpportunities: [],
  recentTrades: [],
};

export function getDashboardState(): Readonly<DashboardState> {
  return state;
}

export function setWalletInfo(address: string, balanceSol: number): void {
  state.walletAddress = address;
  state.walletBalanceSol = balanceSol;
  state.lastUpdated = Date.now();
}

export function setSolPriceUsd(price: number): void {
  state.solPriceUsd = price;
  state.lastUpdated = Date.now();
}

export function setPaused(paused: boolean): void {
  state.paused = paused;
  state.lastUpdated = Date.now();
}

export function setMetrics(metrics: BotMetrics, dailyPnl?: number): void {
  state.metrics = { ...metrics };
  if (dailyPnl !== undefined) state.dailyPnl = dailyPnl;
  state.lastUpdated = Date.now();
}

export function setWatchlist(tokens: Token[]): void {
  state.watchlist = [...tokens];
  state.lastUpdated = Date.now();
}

export function setTokenDexPrices(rows: TokenDexPriceRow[]): void {
  state.tokenDexPrices = [...rows];
  state.lastUpdated = Date.now();
}

export function pushOpportunity(opp: ArbitrageOpportunity): void {
  state.recentOpportunities.unshift(opp);
  if (state.recentOpportunities.length > MAX_RECENT) {
    state.recentOpportunities.pop();
  }
  state.lastUpdated = Date.now();
}

export function pushTrade(result: TradeResult, tokenSymbol?: string): void {
  state.recentTrades.unshift({ ...result, tokenSymbol });
  if (state.recentTrades.length > MAX_RECENT) {
    state.recentTrades.pop();
  }
  state.lastUpdated = Date.now();
}
