import {
  Connection,
  Commitment,
  ConnectionConfig,
} from '@solana/web3.js';
import { logger } from '../utils/logger';

export class RpcManager {
  private connections: Connection[] = [];
  private currentIndex = 0;
  private failCounts: number[] = [];

  constructor(endpoints: string[], commitment: Commitment = 'confirmed') {
    if (endpoints.length === 0) {
      throw new Error('At least one RPC endpoint is required');
    }

    const cfg: ConnectionConfig = {
      commitment,
      confirmTransactionInitialTimeout: 60_000,
      disableRetryOnRateLimit: false,
    };

    this.connections = endpoints.map((url) => new Connection(url, cfg));
    this.failCounts = endpoints.map(() => 0);

    logger.info(`RPC manager initialized with ${endpoints.length} endpoint(s)`);
  }

  /** Get the current primary connection */
  get primary(): Connection {
    return this.connections[this.currentIndex];
  }

  /** Get all connections (for broadcast) */
  get all(): Connection[] {
    return this.connections;
  }

  /** Report a failure on the current RPC */
  reportFailure(): void {
    this.failCounts[this.currentIndex]++;
    const failures = this.failCounts[this.currentIndex];

    if (failures >= 3 && this.connections.length > 1) {
      logger.warn(`RPC endpoint ${this.currentIndex} failed ${failures} times, switching...`);
      this.rotate();
    }
  }

  /** Report success on the current RPC */
  reportSuccess(): void {
    this.failCounts[this.currentIndex] = 0;
  }

  /** Rotate to the next RPC endpoint */
  private rotate(): void {
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;
    logger.info(`Switched to RPC endpoint ${this.currentIndex}`);
  }

  /**
   * Execute a function with automatic failover across RPC endpoints.
   */
  async withFailover<T>(
    fn: (connection: Connection) => Promise<T>,
    label = 'rpc operation',
  ): Promise<T> {
    for (let attempt = 0; attempt < this.connections.length; attempt++) {
      const conn = this.connections[(this.currentIndex + attempt) % this.connections.length];
      try {
        const result = await fn(conn);
        this.reportSuccess();
        return result;
      } catch (err: any) {
        logger.debug(`${label} failed on endpoint ${(this.currentIndex + attempt) % this.connections.length}`, {
          error: err.message,
        });
        if (attempt === this.connections.length - 1) throw err;
      }
    }
    throw new Error(`All RPC endpoints failed for: ${label}`);
  }

  /** Get the latest blockhash with failover */
  async getLatestBlockhash() {
    return this.withFailover(
      (conn) => conn.getLatestBlockhash('confirmed'),
      'getLatestBlockhash',
    );
  }

  /** Get slot with failover */
  async getSlot(): Promise<number> {
    return this.withFailover((conn) => conn.getSlot(), 'getSlot');
  }
}
