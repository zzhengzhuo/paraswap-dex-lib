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
  DexParams,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { AaveV3PtRollOverConfig } from './config';
import PendleRouterABI from '../../abi/PendleRouter.json';

import { ethers, Contract, BigNumber, Signer } from 'ethers';

export class AaveV3PtRollOver
  extends SimpleExchange
  implements IDex<AaveV3PtRollOverData>
{
  readonly hasConstantPriceLargeAmounts = false;

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
  }

  async initializePricing(blockNumber: number) {
    this.logger.info(
      `[AaveV3PtRollOver] Initializing pricing for block ${blockNumber}`,
    );
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
    this.logger.info(
      `Getting prices/volume for ${srcToken.symbol} -> ${
        destToken.symbol
      }, amounts: ${amounts.join(
        ',',
      )}, side: ${side}, block: ${blockNumber}, pools: ${limitPools?.join(
        ',',
      )}`,
    );

    const dexNetworkConfig =
      AaveV3PtRollOverConfig[this.dexKey]?.[this.network];
    if (!dexNetworkConfig) {
      this.logger.error(
        `[${this.dexKey}] Dex config not found for network ${this.network}`,
      );
      return null;
    }

    // Placeholder pricing logic:
    const prices = amounts.map(amount => {
      if (amount === 0n) return 0n;
      if (side === SwapSide.SELL) {
        return (BigInt(amount) * 90n) / 100n; // e.g., 0.9 * amount
      } else {
        return (BigInt(amount) * 100n) / 90n; // Price to buy 'amount' (effectively costs 1.11*amount)
      }
    });

    // Assuming a single pool for simplicity in this placeholder
    const poolPricePayload: AaveV3PtRollOverData = {
      exchange: dexNetworkConfig.pendleRouterAddress,
    };

    return [
      {
        prices,
        unit: 1n,
        data: poolPricePayload,
        exchange: this.dexKey,
        gasCost: CALLDATA_GAS_COST.DEX_NO_PAYLOAD,
      },
    ];
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
    return [];
  }
}

// --- New Service Class for Pendle PT Rollover ---
export class AaveV3PtPendleRolloverService {
  private pendleRouter: Contract;
  private signer: Signer;
  private logger: Logger;
  private readonly dexParams: DexParams;

  constructor(
    signer: Signer,
    dexParams: DexParams,
    dexHelper?: IDexHelper,
    dexKey?: string,
  ) {
    this.signer = signer;
    this.dexParams = dexParams;
    this.pendleRouter = new ethers.Contract(
      this.dexParams.pendleRouterAddress,
      PendleRouterABI,
      this.signer,
    );
    if (dexHelper && dexKey) {
      this.logger = dexHelper.getLogger(`${dexKey}-PendleRolloverService`);
    } else {
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
      tokenOut: this.dexParams.sUSDeTokenAddress, // Use from dexParams
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
      )} OLD_PT (${this.dexParams.oldPtAddress}) for sUSDe (${
        this.dexParams.sUSDeTokenAddress
      }) via market ${this.dexParams.oldMarketAddress}`, // Use from dexParams
    );
    const estimatedOutputsStep1 =
      await this.pendleRouter.callStatic.swapExactPtForToken(
        receiverAddress, // sUSDe will be sent to the final receiver
        this.dexParams.oldMarketAddress, // Use from dexParams
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
        this.dexParams.oldMarketAddress, // Use from dexParams
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
      tokenIn: this.dexParams.sUSDeTokenAddress, // Use from dexParams
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
      )} sUSDe (${this.dexParams.sUSDeTokenAddress}) for New PT via market ${
        this.dexParams.newMarketAddress
      }`, // Use from dexParams
    );
    const estimatedOutputsStep2 =
      await this.pendleRouter.callStatic.swapExactTokenForPt(
        receiverAddress,
        this.dexParams.newMarketAddress, // Use from dexParams
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
        this.dexParams.newMarketAddress, // Use from dexParams
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
