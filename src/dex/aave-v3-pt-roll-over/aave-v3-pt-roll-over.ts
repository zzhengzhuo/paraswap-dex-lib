import { AsyncOrSync } from 'ts-essentials';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import {
  AaveV3PtRollOverData,
  // Import Pendle specific types
  PendleTokenOutput,
  PendleTokenInput,
  PendleApproxParams,
  PendleLimitOrderData,
  IRollOverPtAssetParams,
  IRollOverPtAssetResult,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { AaveV3PtRollOverConfig } from './config';
import { AaveV3PtRollOverEventPool } from './aave-v3-pt-roll-over-pool';

import { ethers, Contract, BigNumber, Signer } from 'ethers';

// --- Constants for Pendle Rollover Service ---
const PENDLE_ROUTER_ADDRESS = '0x888888888889758f76e7103c6cbf23abbf58f946';
const OLD_PT_ADDRESS = '0xb7de5dfcb74d25c2f21841fbd6230355c50d9308';
// const NEW_PT_ADDRESS_TARGET = '0x3b3fb9c57858ef816833dc91565efcd85d96f634'; // Target, but obtained via market
const OLD_MARKET_ADDRESS = '0xb162b764044697cf03617c2efbcb1f42e31e4766';
const NEW_MARKET_ADDRESS = '0x4339ffe2b7592dc783ed13cce310531ab366deac';
const SUSDE_TOKEN_ADDRESS = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'; // Intermediate token (StakedUSDeV2)

const PENDLE_ROUTER_ABI = [
  {
    inputs: [{ internalType: 'int256', name: 'exchangeRate', type: 'int256' }],
    name: 'MarketExchangeRateBelowOne',
    type: 'error',
  },
  { inputs: [], name: 'MarketExpired', type: 'error' },
  { inputs: [], name: 'MarketProportionMustNotEqualOne', type: 'error' },
  {
    inputs: [
      { internalType: 'int256', name: 'proportion', type: 'int256' },
      { internalType: 'int256', name: 'maxProportion', type: 'int256' },
    ],
    name: 'MarketProportionTooHigh',
    type: 'error',
  },
  {
    inputs: [{ internalType: 'int256', name: 'rateScalar', type: 'int256' }],
    name: 'MarketRateScalarBelowZero',
    type: 'error',
  },
  {
    inputs: [
      { internalType: 'int256', name: 'totalPt', type: 'int256' },
      { internalType: 'int256', name: 'totalAsset', type: 'int256' },
    ],
    name: 'MarketZeroTotalPtOrTotalAsset',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyUsed',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPtUsed',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
    ],
    name: 'AddLiquidityDualSyAndPt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'tokenIn',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenUsed',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPtUsed',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'AddLiquidityDualTokenAndPt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPtIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
    ],
    name: 'AddLiquiditySinglePt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
    ],
    name: 'AddLiquiditySingleSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyMintPy',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netYtOut',
        type: 'uint256',
      },
    ],
    name: 'AddLiquiditySingleSyKeepYt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'AddLiquiditySingleToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netYtOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyMintPy',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'AddLiquiditySingleTokenKeepYt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpIn',
        type: 'uint256',
      },
      {
        components: [
          { internalType: 'uint256', name: 'netPtFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netPtRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'totalSyOut', type: 'uint256' },
        ],
        indexed: false,
        internalType: 'struct ExitPostExpReturnParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'ExitPostExpToSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'totalTokenOut',
        type: 'uint256',
      },
      {
        components: [
          { internalType: 'uint256', name: 'netPtFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netPtRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'totalSyOut', type: 'uint256' },
        ],
        indexed: false,
        internalType: 'struct ExitPostExpReturnParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'ExitPostExpToToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpIn',
        type: 'uint256',
      },
      {
        components: [
          { internalType: 'uint256', name: 'netPtFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netPyRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'netPtSwap', type: 'uint256' },
          { internalType: 'uint256', name: 'netYtSwap', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromSwap', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFee', type: 'uint256' },
          { internalType: 'uint256', name: 'totalSyOut', type: 'uint256' },
        ],
        indexed: false,
        internalType: 'struct ExitPreExpReturnParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'ExitPreExpToSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'totalTokenOut',
        type: 'uint256',
      },
      {
        components: [
          { internalType: 'uint256', name: 'netPtFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRemove', type: 'uint256' },
          { internalType: 'uint256', name: 'netPyRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromRedeem', type: 'uint256' },
          { internalType: 'uint256', name: 'netPtSwap', type: 'uint256' },
          { internalType: 'uint256', name: 'netYtSwap', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFromSwap', type: 'uint256' },
          { internalType: 'uint256', name: 'netSyFee', type: 'uint256' },
          { internalType: 'uint256', name: 'totalSyOut', type: 'uint256' },
        ],
        indexed: false,
        internalType: 'struct ExitPreExpReturnParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'ExitPreExpToToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      { indexed: true, internalType: 'address', name: 'YT', type: 'address' },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPyOut',
        type: 'uint256',
      },
    ],
    name: 'MintPyFromSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'tokenIn',
        type: 'address',
      },
      { indexed: true, internalType: 'address', name: 'YT', type: 'address' },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPyOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'MintPyFromToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'tokenIn',
        type: 'address',
      },
      { indexed: true, internalType: 'address', name: 'SY', type: 'address' },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyOut',
        type: 'uint256',
      },
    ],
    name: 'MintSyFromToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'previousOwner',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'newOwner',
        type: 'address',
      },
    ],
    name: 'OwnershipTransferred',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      { indexed: true, internalType: 'address', name: 'YT', type: 'address' },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPyIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyOut',
        type: 'uint256',
      },
    ],
    name: 'RedeemPyToSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'tokenOut',
        type: 'address',
      },
      { indexed: true, internalType: 'address', name: 'YT', type: 'address' },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPyIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'RedeemPyToToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'tokenOut',
        type: 'address',
      },
      { indexed: true, internalType: 'address', name: 'SY', type: 'address' },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenOut',
        type: 'uint256',
      },
    ],
    name: 'RedeemSyToToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpToRemove',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPtOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyOut',
        type: 'uint256',
      },
    ],
    name: 'RemoveLiquidityDualSyAndPt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'tokenOut',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpToRemove',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPtOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'RemoveLiquidityDualTokenAndPt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpToRemove',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netPtOut',
        type: 'uint256',
      },
    ],
    name: 'RemoveLiquiditySinglePt',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpToRemove',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyOut',
        type: 'uint256',
      },
    ],
    name: 'RemoveLiquiditySingleSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netLpToRemove',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netTokenOut',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'RemoveLiquiditySingleToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes4',
        name: 'selector',
        type: 'bytes4',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'facet',
        type: 'address',
      },
    ],
    name: 'SelectorToFacetSet',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netPtToAccount',
        type: 'int256',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netSyToAccount',
        type: 'int256',
      },
    ],
    name: 'SwapPtAndSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netPtToAccount',
        type: 'int256',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netTokenToAccount',
        type: 'int256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'SwapPtAndToken',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netYtToAccount',
        type: 'int256',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netSyToAccount',
        type: 'int256',
      },
    ],
    name: 'SwapYtAndSy',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netYtToAccount',
        type: 'int256',
      },
      {
        indexed: false,
        internalType: 'int256',
        name: 'netTokenToAccount',
        type: 'int256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'netSyInterm',
        type: 'uint256',
      },
    ],
    name: 'SwapYtAndToken',
    type: 'event',
  },
  {
    inputs: [
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'market', type: 'address' },
      { internalType: 'uint256', name: 'exactPtIn', type: 'uint256' },
      { internalType: 'uint256', name: 'minSyOut', type: 'uint256' },
      {
        components: [
          { internalType: 'address', name: 'limitRouter', type: 'address' },
          { internalType: 'uint256', name: 'epsSkipMarket', type: 'uint256' },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'normalFills',
            type: 'tuple[]',
          },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'flashFills',
            type: 'tuple[]',
          },
          { internalType: 'bytes', name: 'optData', type: 'bytes' },
        ],
        internalType: 'struct LimitOrderData',
        name: 'limit',
        type: 'tuple',
      },
    ],
    name: 'swapExactPtForSy',
    outputs: [
      { internalType: 'uint256', name: 'netSyOut', type: 'uint256' },
      { internalType: 'uint256', name: 'netSyFee', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'market', type: 'address' },
      { internalType: 'uint256', name: 'exactPtIn', type: 'uint256' },
      {
        components: [
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'uint256', name: 'minTokenOut', type: 'uint256' },
          { internalType: 'address', name: 'tokenRedeemSy', type: 'address' },
          { internalType: 'address', name: 'pendleSwap', type: 'address' },
          {
            components: [
              {
                internalType: 'enum SwapType',
                name: 'swapType',
                type: 'uint8',
              },
              { internalType: 'address', name: 'extRouter', type: 'address' },
              { internalType: 'bytes', name: 'extCalldata', type: 'bytes' },
              { internalType: 'bool', name: 'needScale', type: 'bool' },
            ],
            internalType: 'struct SwapData',
            name: 'swapData',
            type: 'tuple',
          },
        ],
        internalType: 'struct TokenOutput',
        name: 'output',
        type: 'tuple',
      },
      {
        components: [
          { internalType: 'address', name: 'limitRouter', type: 'address' },
          { internalType: 'uint256', name: 'epsSkipMarket', type: 'uint256' },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'normalFills',
            type: 'tuple[]',
          },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'flashFills',
            type: 'tuple[]',
          },
          { internalType: 'bytes', name: 'optData', type: 'bytes' },
        ],
        internalType: 'struct LimitOrderData',
        name: 'limit',
        type: 'tuple',
      },
    ],
    name: 'swapExactPtForToken',
    outputs: [
      { internalType: 'uint256', name: 'netTokenOut', type: 'uint256' },
      { internalType: 'uint256', name: 'netSyFee', type: 'uint256' },
      { internalType: 'uint256', name: 'netSyInterm', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'market', type: 'address' },
      { internalType: 'uint256', name: 'exactSyIn', type: 'uint256' },
      { internalType: 'uint256', name: 'minPtOut', type: 'uint256' },
      {
        components: [
          { internalType: 'uint256', name: 'guessMin', type: 'uint256' },
          { internalType: 'uint256', name: 'guessMax', type: 'uint256' },
          { internalType: 'uint256', name: 'guessOffchain', type: 'uint256' },
          { internalType: 'uint256', name: 'maxIteration', type: 'uint256' },
          { internalType: 'uint256', name: 'eps', type: 'uint256' },
        ],
        internalType: 'struct ApproxParams',
        name: 'guessPtOut',
        type: 'tuple',
      },
      {
        components: [
          { internalType: 'address', name: 'limitRouter', type: 'address' },
          { internalType: 'uint256', name: 'epsSkipMarket', type: 'uint256' },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'normalFills',
            type: 'tuple[]',
          },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'flashFills',
            type: 'tuple[]',
          },
          { internalType: 'bytes', name: 'optData', type: 'bytes' },
        ],
        internalType: 'struct LimitOrderData',
        name: 'limit',
        type: 'tuple',
      },
    ],
    name: 'swapExactSyForPt',
    outputs: [
      { internalType: 'uint256', name: 'netPtOut', type: 'uint256' },
      { internalType: 'uint256', name: 'netSyFee', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'market', type: 'address' },
      { internalType: 'uint256', name: 'minPtOut', type: 'uint256' },
      {
        components: [
          { internalType: 'uint256', name: 'guessMin', type: 'uint256' },
          { internalType: 'uint256', name: 'guessMax', type: 'uint256' },
          { internalType: 'uint256', name: 'guessOffchain', type: 'uint256' },
          { internalType: 'uint256', name: 'maxIteration', type: 'uint256' },
          { internalType: 'uint256', name: 'eps', type: 'uint256' },
        ],
        internalType: 'struct ApproxParams',
        name: 'guessPtOut',
        type: 'tuple',
      },
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'uint256', name: 'netTokenIn', type: 'uint256' },
          { internalType: 'address', name: 'tokenMintSy', type: 'address' },
          { internalType: 'address', name: 'pendleSwap', type: 'address' },
          {
            components: [
              {
                internalType: 'enum SwapType',
                name: 'swapType',
                type: 'uint8',
              },
              { internalType: 'address', name: 'extRouter', type: 'address' },
              { internalType: 'bytes', name: 'extCalldata', type: 'bytes' },
              { internalType: 'bool', name: 'needScale', type: 'bool' },
            ],
            internalType: 'struct SwapData',
            name: 'swapData',
            type: 'tuple',
          },
        ],
        internalType: 'struct TokenInput',
        name: 'input',
        type: 'tuple',
      },
      {
        components: [
          { internalType: 'address', name: 'limitRouter', type: 'address' },
          { internalType: 'uint256', name: 'epsSkipMarket', type: 'uint256' },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'normalFills',
            type: 'tuple[]',
          },
          {
            components: [
              {
                components: [
                  { internalType: 'uint256', name: 'salt', type: 'uint256' },
                  { internalType: 'uint256', name: 'expiry', type: 'uint256' },
                  { internalType: 'uint256', name: 'nonce', type: 'uint256' },
                  {
                    internalType: 'enum IPLimitOrderType.OrderType',
                    name: 'orderType',
                    type: 'uint8',
                  },
                  { internalType: 'address', name: 'token', type: 'address' },
                  { internalType: 'address', name: 'YT', type: 'address' },
                  { internalType: 'address', name: 'maker', type: 'address' },
                  {
                    internalType: 'address',
                    name: 'receiver',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'makingAmount',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'lnImpliedRate',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'failSafeRate',
                    type: 'uint256',
                  },
                  { internalType: 'bytes', name: 'permit', type: 'bytes' },
                ],
                internalType: 'struct Order',
                name: 'order',
                type: 'tuple',
              },
              { internalType: 'bytes', name: 'signature', type: 'bytes' },
              {
                internalType: 'uint256',
                name: 'makingAmount',
                type: 'uint256',
              },
            ],
            internalType: 'struct FillOrderParams[]',
            name: 'flashFills',
            type: 'tuple[]',
          },
          { internalType: 'bytes', name: 'optData', type: 'bytes' },
        ],
        internalType: 'struct LimitOrderData',
        name: 'limit',
        type: 'tuple',
      },
    ],
    name: 'swapExactTokenForPt',
    outputs: [
      { internalType: 'uint256', name: 'netPtOut', type: 'uint256' },
      { internalType: 'uint256', name: 'netSyFee', type: 'uint256' },
      { internalType: 'uint256', name: 'netSyInterm', type: 'uint256' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
];

export class AaveV3PtRollOver
  extends SimpleExchange
  implements IDex<AaveV3PtRollOverData>
{
  protected eventPools: AaveV3PtRollOverEventPool;

  readonly hasConstantPriceLargeAmounts = false;
  // TODO: set true here if protocols works only with wrapped asset
  readonly needWrapNative = true;

  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AaveV3PtRollOverConfig);

  logger: Logger;

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    this.eventPools = new AaveV3PtRollOverEventPool(
      dexKey,
      network,
      dexHelper,
      this.logger,
    );
  }

  async initializePricing(blockNumber: number) {
    // TODO: complete me!
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    // TODO: complete me!
    return [];
  }

  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AaveV3PtRollOverData>> {
    // TODO: complete me!
    return null;
  }

  getCalldataGasCost(
    poolPrices: PoolPrices<AaveV3PtRollOverData>,
  ): number | number[] {
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AaveV3PtRollOverData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const { exchange } = data;
    const payload = '';
    return {
      targetExchange: exchange,
      payload,
      networkFee: '0',
    };
  }

  async updatePoolState(): Promise<void> {
    // TODO: complete me!
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    //TODO: complete me!
    return [];
  }

  releaseResources(): AsyncOrSync<void> {
    // TODO: complete me!
  }
}

// --- New Service Class for Pendle PT Rollover ---
export class AaveV3PtPendleRolloverService {
  private pendleRouter: Contract;
  private signer: Signer;
  private logger: Logger; // Optional: if logging is needed within the service

  constructor(signer: Signer, dexHelper?: IDexHelper, dexKey?: string) {
    this.signer = signer;
    this.pendleRouter = new ethers.Contract(
      PENDLE_ROUTER_ADDRESS,
      PENDLE_ROUTER_ABI,
      this.signer,
    );
    // Optionally initialize logger if dexHelper and dexKey are provided
    if (dexHelper && dexKey) {
      this.logger = dexHelper.getLogger(`${dexKey}-PendleRolloverService`);
    } else {
      // Fallback to console logging if no logger infra is passed
      this.logger = console as any;
    }
  }

  private getDefaultLimitOrderData(): PendleLimitOrderData {
    return {
      limitRouter: ethers.constants.AddressZero,
      epsSkipMarket: BigNumber.from(0),
      normalFills: [],
      flashFills: [],
      optData: '0x',
    };
  }

  private getDefaultApproxParams(): PendleApproxParams {
    return {
      guessMin: BigNumber.from(0),
      guessMax: ethers.constants.MaxUint256,
      guessOffchain: BigNumber.from(0),
      maxIteration: BigNumber.from(20),
      eps: BigNumber.from('100000000000000'), // 1e14 (0.0001% error)
    };
  }

  private calculateMinAmountOut(
    expectedAmountOut: BigNumber,
    slippageToleranceBps: number,
  ): BigNumber {
    if (slippageToleranceBps < 0 || slippageToleranceBps > 10000) {
      this.logger.error('Slippage tolerance must be between 0 and 10000 bps.');
      throw new Error('Slippage tolerance must be between 0 and 10000 bps.');
    }
    const slippageFactor = BigNumber.from(10000 - slippageToleranceBps);
    return expectedAmountOut.mul(slippageFactor).div(10000);
  }

  async rollOverPtAsset(
    params: IRollOverPtAssetParams,
  ): Promise<IRollOverPtAssetResult> {
    const { amountPtIn, receiverAddress, slippageToleranceBps = 50 } = params; // 50 bps = 0.5%
    this.logger.info('[PendleRollover] Starting PT rollover process...', {
      amountPtIn: amountPtIn.toString(),
      receiverAddress,
    });

    const limitOrderData = this.getDefaultLimitOrderData();

    // STEP 1: Swap Exact Old PT for sUSDe (Intermediate Token)
    const tokenOutputArgsForEstimation: PendleTokenOutput = {
      tokenOut: SUSDE_TOKEN_ADDRESS,
      minTokenOut: BigNumber.from(0), // Not used for estimation, but required by type
      tokenRedeemSy: ethers.constants.AddressZero,
      pendleSwap: ethers.constants.AddressZero,
      swapData: {
        swapType: 0,
        extRouter: ethers.constants.AddressZero,
        extCalldata: '0x',
        needScale: false,
      },
    };

    this.logger.info(
      `[PendleRollover] Estimating Step 1: Swapping ${ethers.utils.formatUnits(
        amountPtIn,
      )} OLD_PT (${OLD_PT_ADDRESS}) for sUSDe (${SUSDE_TOKEN_ADDRESS}) via market ${OLD_MARKET_ADDRESS}`,
    );
    const estimatedOutputsStep1 =
      await this.pendleRouter.callStatic.swapExactPtForToken(
        receiverAddress, // sUSDe will be sent to the final receiver
        OLD_MARKET_ADDRESS,
        amountPtIn,
        tokenOutputArgsForEstimation,
        limitOrderData,
      );
    const expectedIntermediateTokenOut: BigNumber =
      estimatedOutputsStep1.netTokenOut;
    if (expectedIntermediateTokenOut.isZero()) {
      this.logger.error(
        '[PendleRollover] Step 1 Estimation: Expected zero sUSDe. Check parameters or market liquidity.',
      );
      throw new Error(
        'Step 1 Estimation: Expected zero sUSDe. Check parameters or market liquidity.',
      );
    }
    const minIntermediateTokenOut = this.calculateMinAmountOut(
      expectedIntermediateTokenOut,
      slippageToleranceBps,
    );
    this.logger.info(
      `[PendleRollover] Step 1 Estimation - Expected sUSDe: ${ethers.utils.formatUnits(
        expectedIntermediateTokenOut,
      )}, Min sUSDe out: ${ethers.utils.formatUnits(minIntermediateTokenOut)}`,
    );

    const tokenOutputArgsExecute: PendleTokenOutput = {
      ...tokenOutputArgsForEstimation,
      minTokenOut: minIntermediateTokenOut,
    };

    this.logger.info(
      `[PendleRollover] Executing Step 1: Swapping OLD_PT for sUSDe...`,
    );
    const tx1 = await this.pendleRouter
      .connect(this.signer)
      .swapExactPtForToken(
        receiverAddress,
        OLD_MARKET_ADDRESS,
        amountPtIn,
        tokenOutputArgsExecute,
        limitOrderData,
      );
    const receipt1 = await tx1.wait();
    this.logger.info(
      `[PendleRollover] Step 1 completed. Tx: ${receipt1.transactionHash}`,
    );

    // Assuming the static call was accurate enough. For critical applications, parse logs from receipt1.
    const actualIntermediateTokenReceived = expectedIntermediateTokenOut;

    // STEP 2: Swap Exact sUSDe for New PT
    const approxParams = this.getDefaultApproxParams();
    const tokenInputArgsForEstimation: PendleTokenInput = {
      tokenIn: SUSDE_TOKEN_ADDRESS,
      netTokenIn: actualIntermediateTokenReceived,
      tokenMintSy: ethers.constants.AddressZero,
      pendleSwap: ethers.constants.AddressZero,
      swapData: {
        swapType: 0,
        extRouter: ethers.constants.AddressZero,
        extCalldata: '0x',
        needScale: false,
      },
    };

    this.logger.info(
      `[PendleRollover] Estimating Step 2: Swapping ${ethers.utils.formatUnits(
        actualIntermediateTokenReceived,
      )} sUSDe (${SUSDE_TOKEN_ADDRESS}) for New PT via market ${NEW_MARKET_ADDRESS}`,
    );
    const estimatedOutputsStep2 =
      await this.pendleRouter.callStatic.swapExactTokenForPt(
        receiverAddress,
        NEW_MARKET_ADDRESS,
        BigNumber.from(0), // minPtOut for estimation, actual will be calculated
        approxParams,
        tokenInputArgsForEstimation,
        limitOrderData,
      );
    const expectedNewPtOut: BigNumber = estimatedOutputsStep2.netPtOut;
    if (expectedNewPtOut.isZero()) {
      this.logger.error(
        '[PendleRollover] Step 2 Estimation: Expected zero New PT. Check parameters or market liquidity.',
      );
      throw new Error(
        'Step 2 Estimation: Expected zero New PT. Check parameters or market liquidity.',
      );
    }
    const minNewPtOut = this.calculateMinAmountOut(
      expectedNewPtOut,
      slippageToleranceBps,
    );
    this.logger.info(
      `[PendleRollover] Step 2 Estimation - Expected New PT: ${ethers.utils.formatUnits(
        expectedNewPtOut,
      )}, Min New PT out: ${ethers.utils.formatUnits(minNewPtOut)}`,
    );

    const tokenInputArgsExecute: PendleTokenInput = {
      ...tokenInputArgsForEstimation,
    }; // netTokenIn is already set to actualIntermediateTokenReceived

    this.logger.info(
      `[PendleRollover] Executing Step 2: Swapping sUSDe for New PT...`,
    );
    // Note: swapExactTokenForPt is payable. If sUSDe needs wrapping from ETH or similar, value might be needed.
    // Assuming sUSDe is an ERC20 and already available/approved.
    const tx2 = await this.pendleRouter
      .connect(this.signer)
      .swapExactTokenForPt(
        receiverAddress,
        NEW_MARKET_ADDRESS,
        minNewPtOut, // Use calculated minPtOut for execution
        approxParams,
        tokenInputArgsExecute,
        limitOrderData,
      );
    const receipt2 = await tx2.wait();
    this.logger.info(
      `[PendleRollover] Step 2 completed. Tx: ${receipt2.transactionHash}`,
    );

    // Assuming static call was accurate. For critical applications, parse logs.
    const actualNewPtReceived = expectedNewPtOut;

    this.logger.info(
      `[PendleRollover] Rollover process finished successfully.`,
    );
    return {
      newPtAmount: actualNewPtReceived,
      intermediateTokenAmount: actualIntermediateTokenReceived,
      transactionHashStep1: receipt1.transactionHash,
      transactionHashStep2: receipt2.transactionHash,
    };
  }
}
