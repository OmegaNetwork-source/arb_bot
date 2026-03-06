import {
  VersionedTransaction,
  Keypair,
  Connection,
} from '@solana/web3.js';
import { ArbitrageOpportunity, TradeResult } from '../types';
import { JupiterClient } from '../dex/jupiter';
import { JitoClient } from './jitoClient';
import { RpcManager } from './rpcManager';
import { sleep, formatSol } from '../utils/helpers';
import { logger } from '../utils/logger';

export interface ExecutorConfig {
  jitoTipLamports: number;
  priorityFeeMicroLamports: number;
  maxRetries: number;
  bundleConfirmTimeoutMs: number;
}

export class Executor {
  constructor(
    private readonly wallet: Keypair,
    private readonly jupiter: JupiterClient,
    private readonly jito: JitoClient,
    private readonly rpc: RpcManager,
    private readonly cfg: ExecutorConfig,
  ) {}

  /**
   * Execute an arbitrage opportunity as a Jito bundle.
   * Flow:
   * 1. Get swap transactions from Jupiter for buy and sell
   * 2. Deserialize + re-sign with fresh blockhash
   * 3. Add Jito tip transaction
   * 4. Send bundle [tip_tx, buy_tx, sell_tx]
   * 5. Wait for confirmation
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<TradeResult> {
    const startTime = Date.now();
    const { id, token, buyQuote, sellQuote } = opportunity;

    logger.info(`Executing opportunity ${id}`, {
      token: token.symbol,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex,
      expectedProfit: formatSol(opportunity.netProfitSol),
    });

    // Step 1: Get swap transactions from Jupiter
    const [buySwapResp, sellSwapResp] = await Promise.all([
      this.jupiter.getSwapTransaction(
        buyQuote,
        this.wallet.publicKey.toBase58(),
        this.cfg.priorityFeeMicroLamports,
      ),
      this.jupiter.getSwapTransaction(
        sellQuote,
        this.wallet.publicKey.toBase58(),
        this.cfg.priorityFeeMicroLamports,
      ),
    ]);

    if (!buySwapResp || !sellSwapResp) {
      logger.error(`Failed to get swap transactions for opportunity ${id}`);
      return {
        opportunityId: id,
        success: false,
        errorMessage: 'Failed to get swap transactions from Jupiter',
        executedAt: startTime,
      };
    }

    // Step 2: Deserialize transactions
    let buyTx: VersionedTransaction;
    let sellTx: VersionedTransaction;

    try {
      buyTx = VersionedTransaction.deserialize(
        Buffer.from(buySwapResp.swapTransaction, 'base64'),
      );
      sellTx = VersionedTransaction.deserialize(
        Buffer.from(sellSwapResp.swapTransaction, 'base64'),
      );
    } catch (err: any) {
      logger.error(`Failed to deserialize swap transactions`, { error: err.message });
      return {
        opportunityId: id,
        success: false,
        errorMessage: `Transaction deserialization failed: ${err.message}`,
        executedAt: startTime,
      };
    }

    // Step 3: Get fresh blockhash and re-sign
    const connection = this.rpc.primary;

    try {
      const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash();

      buyTx.message.recentBlockhash = blockhash;
      sellTx.message.recentBlockhash = blockhash;

      buyTx.sign([this.wallet]);
      sellTx.sign([this.wallet]);

      // Step 4: Build tip transaction
      const tipTx = await this.jito.buildTipTransaction(
        this.wallet,
        this.cfg.jitoTipLamports,
        connection,
      );
      // Update tip tx blockhash too
      tipTx.message.recentBlockhash = blockhash;
      tipTx.sign([this.wallet]);

      // Step 5: Send bundle [tip, buy, sell]
      const bundleId = await this.jito.sendBundle([tipTx, buyTx, sellTx]);

      if (!bundleId) {
        return {
          opportunityId: id,
          success: false,
          errorMessage: 'Jito bundle submission failed',
          executedAt: startTime,
        };
      }

      // Step 6: Wait for bundle confirmation
      const confirmed = await this.waitForBundleConfirmation(
        bundleId,
        lastValidBlockHeight,
        connection,
      );

      if (!confirmed) {
        return {
          opportunityId: id,
          success: false,
          bundleId,
          errorMessage: 'Bundle not confirmed within timeout',
          executedAt: startTime,
        };
      }

      const status = await this.jito.getBundleStatus(bundleId);
      const txSigs = status?.transactions ?? [];

      logger.info(`Opportunity ${id} executed successfully!`, {
        bundleId,
        buyTx: txSigs[1],
        sellTx: txSigs[2],
        expectedProfit: formatSol(opportunity.netProfitSol),
      });

      return {
        opportunityId: id,
        success: true,
        bundleId,
        buyTxSignature: txSigs[1],
        sellTxSignature: txSigs[2],
        actualProfitSol: opportunity.netProfitSol, // approximate (actual depends on fill prices)
        executedAt: startTime,
        confirmedAt: Date.now(),
      };
    } catch (err: any) {
      logger.error(`Execution failed for opportunity ${id}`, { error: err.message });
      this.rpc.reportFailure();
      return {
        opportunityId: id,
        success: false,
        errorMessage: err.message,
        executedAt: startTime,
      };
    }
  }

  private async waitForBundleConfirmation(
    bundleId: string,
    lastValidBlockHeight: number,
    connection: Connection,
  ): Promise<boolean> {
    const timeout = this.cfg.bundleConfirmTimeoutMs;
    const pollIntervalMs = 1_000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check if block height exceeded (bundle expired)
      try {
        const currentHeight = await connection.getBlockHeight();
        if (currentHeight > lastValidBlockHeight) {
          logger.warn(`Bundle ${bundleId} expired (block height exceeded)`);
          return false;
        }
      } catch {
        // ignore RPC errors here
      }

      // Check bundle status
      const status = await this.jito.getBundleStatus(bundleId);
      if (status?.landed) {
        return true;
      }

      await sleep(pollIntervalMs);
    }

    logger.warn(`Bundle ${bundleId} confirmation timeout after ${timeout}ms`);
    return false;
  }
}
