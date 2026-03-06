import { lamportsToSol } from '../utils/helpers';

export interface FeeEstimate {
  priorityFeeSol: number;
  jitoTipSol: number;
  baseFeeSol: number;
  totalFeeSol: number;
}

/**
 * Estimate total fees for a 2-transaction Jito bundle arb (in SOL).
 */
export function estimateFees(
  _solPriceUsdc: number,
  priorityFeeMicroLamports: number,
  jitoTipLamports: number,
): FeeEstimate {
  const computeUnitsPerTx = 200_000;
  const txCount = 2;

  const totalPriorityLamports = (priorityFeeMicroLamports / 1_000_000) * computeUnitsPerTx * txCount;
  const baseFeeLamports = 5_000 * 2 * txCount;
  const totalLamports = totalPriorityLamports + jitoTipLamports + baseFeeLamports;
  const totalSol = totalLamports / 1_000_000_000;

  return {
    priorityFeeSol: totalPriorityLamports / 1_000_000_000,
    jitoTipSol: jitoTipLamports / 1_000_000_000,
    baseFeeSol: baseFeeLamports / 1_000_000_000,
    totalFeeSol: totalSol,
  };
}

export interface ProfitCalculation {
  inputSol: number;
  buyOutputAmount: bigint;
  sellOutputSol: number;
  grossProfitSol: number;
  feesSol: number;
  netProfitSol: number;
  profitPct: number;
  isProfitable: boolean;
}

/**
 * Calculate net profit for an arb opportunity (SOL in / SOL out).
 */
export function calculateProfit(
  inputSol: number,
  buyOutputAmount: bigint,
  sellOutputLamports: bigint, // SOL received from sell (in lamports)
  fees: FeeEstimate,
  minProfitSol: number,
): ProfitCalculation {
  const sellOutputSol = lamportsToSol(sellOutputLamports);
  const grossProfitSol = sellOutputSol - inputSol;
  const netProfitSol = grossProfitSol - fees.totalFeeSol;
  const profitPct = inputSol > 0 ? netProfitSol / inputSol : 0;
  const isProfitable = netProfitSol >= minProfitSol;

  return {
    inputSol,
    buyOutputAmount,
    sellOutputSol,
    grossProfitSol,
    feesSol: fees.totalFeeSol,
    netProfitSol,
    profitPct,
    isProfitable,
  };
}
