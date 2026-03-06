import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { USDC_MINT, TOKEN_DECIMALS } from '../config/constants';

/** Load a Keypair from a base58-encoded private key */
export function loadKeypair(privateKeyBase58: string): Keypair {
  try {
    const decoded = bs58.decode(privateKeyBase58);
    return Keypair.fromSecretKey(decoded);
  } catch {
    // Try as JSON array (Phantom/Solflare format)
    try {
      const arr = JSON.parse(privateKeyBase58) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      throw new Error('Invalid private key format. Expected base58 string or JSON number array.');
    }
  }
}

/** Convert USDC amount (human-readable) to lamports */
export function usdcToLamports(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1_000_000));
}

/** Convert USDC lamports to human-readable */
export function lamportsToUsdc(lamports: bigint): number {
  return Number(lamports) / 1_000_000;
}

/** Convert SOL lamports to SOL */
export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / 1_000_000_000;
}

/** Convert SOL to lamports */
export function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000);
}

/** Get token decimals (falls back to 6 for unknown tokens) */
export function getTokenDecimals(mint: string): number {
  return TOKEN_DECIMALS[mint] ?? 6;
}

/** Format a number as a fixed decimal string */
export function formatNumber(n: number, decimals = 4): string {
  return n.toFixed(decimals);
}

/** Format USD amount */
export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Format SOL amount */
export function formatSol(n: number): string {
  return `${n.toFixed(6)} SOL`;
}

/** Format a profit percentage */
export function formatPct(n: number): string {
  return `${(n * 100).toFixed(3)}%`;
}

/** Shorten a public key for display */
export function shortKey(key: string | PublicKey): string {
  const k = key.toString();
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Sleep for N milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry an async function with exponential backoff */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500,
  label = 'operation',
): Promise<T> {
  let lastError: Error | unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/** Generate a unique ID for opportunities */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Is the given mint address USDC? */
export function isUsdc(mint: string): boolean {
  return mint === USDC_MINT;
}

/** Clamp a value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Pick a random element from an array */
export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Chunk an array into sub-arrays of size n */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Deduplicate an array by a key function */
export function dedupeBy<T>(arr: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
