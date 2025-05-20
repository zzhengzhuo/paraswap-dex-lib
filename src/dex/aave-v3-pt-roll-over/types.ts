import { Address } from '../../types';
import { BigNumber } from 'ethers';

// Represents the combined state relevant for the AaveV3 PT Rollover.
// This state is expected to be maintained by an event subscriber (e.g., AaveV3PtRollOverEventPool)
// and used for price calculations.

export type PoolState = {
  price: bigint;
};

export type AaveV3PtRollOverData = {
  exchange: Address;
};

export type DexParams = {
  pendleRouterAddress: Address;
  oldPtAddress: Address;
  oldMarketAddress: Address;
  newMarketAddress: Address;
  sUSDeTokenAddress: Address;
  pendleChainlinkOracleAddress: Address;
};

// --- Pendle Router Specific Types ---

export interface PendleSwapData {
  swapType: number;
  extRouter: Address;
  extCalldata: string; // bytes
  needScale: boolean;
}

export interface PendleTokenOutput {
  tokenOut: Address;
  minTokenOut: BigNumber;
  tokenRedeemSy: Address;
  pendleSwap: Address;
  swapData: PendleSwapData;
}

export interface PendleTokenInput {
  tokenIn: Address;
  netTokenIn: BigNumber;
  tokenMintSy: Address;
  pendleSwap: Address;
  swapData: PendleSwapData;
}

export interface PendleApproxParams {
  guessMin: BigNumber;
  guessMax: BigNumber;
  guessOffchain: BigNumber;
  maxIteration: BigNumber;
  eps: BigNumber;
}

// Minimal structure for FillOrderParams for Pendle Limit Orders
// Expand if full limit order features are needed
export interface PendleFillOrderParams {
  order: any; // Replace 'any' with the actual Pendle Order struct if needed
  signature: string; // bytes
  makingAmount: BigNumber;
}

export interface PendleLimitOrderData {
  limitRouter: Address;
  epsSkipMarket: BigNumber;
  normalFills: PendleFillOrderParams[];
  flashFills: PendleFillOrderParams[];
  optData: string; // bytes
}

export interface IRollOverPtAssetParams {
  // Signer will be part of the service class instance
  amountPtIn: BigNumber; // Amount of old PT to roll over
  receiverAddress: Address; // Address to receive the new PT and any residuals
  slippageToleranceBps?: number; // Slippage in basis points (e.g., 50 for 0.5%)
  // intermediateTokenAddress is fixed to sUSDe for this specific rollover
}

export interface IRollOverPtAssetResult {
  newPtAmount: BigNumber;
  intermediateTokenAmount: BigNumber; // Amount of sUSDe received and used
  transactionHashStep1: string;
  transactionHashStep2: string;
}
