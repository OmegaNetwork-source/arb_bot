import axios, { AxiosInstance } from 'axios';
import {
  VersionedTransaction,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  Keypair,
  Connection,
} from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS } from '../config/constants';
import { JitoBundleResponse } from '../types';
import { randomPick } from '../utils/helpers';
import { logger } from '../utils/logger';

export class JitoClient {
  private client: AxiosInstance;

  constructor(blockEngineUrl: string) {
    this.client = axios.create({
      baseURL: blockEngineUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Get a random Jito tip account public key */
  getTipAccount(): PublicKey {
    return new PublicKey(randomPick(JITO_TIP_ACCOUNTS));
  }

  /**
   * Build a Jito tip transfer transaction.
   * This must be included in the bundle to pay the block engine.
   */
  async buildTipTransaction(
    payer: Keypair,
    tipLamports: number,
    connection: Connection,
  ): Promise<VersionedTransaction> {
    const tipAccount = this.getTipAccount();
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: tipAccount,
          lamports: tipLamports,
        }),
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx;
  }

  /**
   * Submit a bundle of transactions to the Jito block engine.
   * Returns the bundle ID on success.
   *
   * Bundle format: array of base58-encoded serialized transactions.
   * Max 5 transactions per bundle.
   */
  async sendBundle(transactions: VersionedTransaction[]): Promise<string | null> {
    if (transactions.length === 0 || transactions.length > 5) {
      throw new Error(`Bundle must contain 1-5 transactions, got ${transactions.length}`);
    }

    // Serialize each transaction to base58
    const encodedTxs = transactions.map((tx) => {
      const serialized = tx.serialize();
      return Buffer.from(serialized).toString('base64');
    });

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [encodedTxs],
    };

    try {
      const resp = await this.client.post<JitoBundleResponse>('/api/v1/bundles', payload);
      const data = resp.data;

      if (data.error) {
        logger.error('Jito bundle rejected', { error: data.error });
        return null;
      }

      const bundleId = data.result;
      logger.info(`Jito bundle submitted: ${bundleId}`);
      return bundleId ?? null;
    } catch (err: any) {
      logger.error('Jito bundle submission failed', { error: err.message });
      return null;
    }
  }

  /**
   * Check the status of a bundle.
   */
  async getBundleStatus(bundleId: string): Promise<BundleStatus | null> {
    try {
      const resp = await this.client.post('/api/v1/bundles', {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      });

      const statuses = resp.data?.result?.value as BundleStatusItem[] | undefined;
      if (!statuses || statuses.length === 0) return null;

      const item = statuses[0];
      return {
        bundleId,
        status: item.confirmation_status ?? 'unknown',
        transactions: item.transactions ?? [],
        landed: item.confirmation_status === 'finalized' || item.confirmation_status === 'confirmed',
      };
    } catch (err: any) {
      logger.debug('getBundleStatus failed', { bundleId, error: err.message });
      return null;
    }
  }
}

export interface BundleStatus {
  bundleId: string;
  status: string;
  transactions: string[];
  landed: boolean;
}

interface BundleStatusItem {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: string;
  err: { Ok: null } | { Err: unknown };
}
