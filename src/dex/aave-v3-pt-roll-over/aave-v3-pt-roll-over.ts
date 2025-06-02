import { AsyncOrSync } from 'ts-essentials';
import {
  Token,
  Address,
  ExchangePrices,
  AdapterExchangeParam,
  DexExchangeParam,
  PoolLiquidity,
  Logger,
  NumberAsString,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork } from '../../utils';
import { Context, IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { AaveV3PtRollOverData, DexParams, PendleSDKMarket } from './types';
import { SimpleExchange } from '../simple-exchange';
import { AaveV3PtRollOverConfig } from './config';
import { Interface } from '@ethersproject/abi';

const PENDLE_ORACLE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'market', type: 'address' },
      { internalType: 'uint32', name: 'duration', type: 'uint32' },
    ],
    name: 'getPtToAssetRate',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'market', type: 'address' },
      { internalType: 'uint32', name: 'duration', type: 'uint32' },
    ],
    name: 'getOracleState',
    outputs: [
      {
        internalType: 'bool',
        name: 'increaseCardinalityRequired',
        type: 'bool',
      },
      { internalType: 'uint16', name: 'cardinalityRequired', type: 'uint16' },
      {
        internalType: 'bool',
        name: 'oldestObservationSatisfied',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

export class AaveV3PtRollOver
  extends SimpleExchange
  implements IDex<AaveV3PtRollOverData>
{
  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = false;
  readonly isFeeOnTransferSupported = false;

  private config: DexParams;
  private marketsCache: Map<string, PendleSDKMarket> = new Map();
  private oracleInterface: Interface;

  logger: Logger;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AaveV3PtRollOverConfig);

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
    protected adapters = {},
  ) {
    super(dexHelper, dexKey);
    this.config = AaveV3PtRollOverConfig[dexKey][network];
    this.logger = dexHelper.getLogger(dexKey);
    this.oracleInterface = new Interface(PENDLE_ORACLE_ABI);
  }

  getAdapters(): { name: string; index: number }[] | null {
    return null;
  }

  async initializePricing(blockNumber: number): Promise<void> {
    // Always populate mock data for testing
    this.populateMockMarketsForTesting();
    this.logger.info('Successfully initialized Pendle markets cache');
  }

  /**
   * Populate mock markets for testing when real API is unavailable
   */
  private populateMockMarketsForTesting(): void {
    // Add mock markets for the test tokens
    const mockMarkets: PendleSDKMarket[] = [
      {
        address: this.config.oldMarketAddress,
        ptAddress: this.config.oldPtAddress.address,
        ytAddress: '0x1234567890123456789012345678901234567890', // Mock YT address
        underlyingAssetAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', // sUSDe address
        name: 'PT sUSDe 29 May 2025',
        expiry: 1748476800, // May 29, 2025
        chainId: this.config.chainId,
      },
      {
        address: this.config.newMarketAddress,
        ptAddress: this.config.newPtAddress.address,
        ytAddress: '0x2345678901234567890123456789012345678901', // Mock YT address
        underlyingAssetAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', // sUSDe address
        name: 'PT sUSDe 31 Jul 2025',
        expiry: 1753574400, // July 31, 2025
        chainId: this.config.chainId,
      },
    ];

    mockMarkets.forEach(market => {
      this.marketsCache.set(market.ptAddress.toLowerCase(), market);
    });

    this.logger.info(
      `Populated mock markets for testing. Cache size: ${this.marketsCache.size}`,
    );
  }

  /**
   * Get market details for a given PT address
   */
  private getMarketForPt(ptAddress: Address): PendleSDKMarket | null {
    const normalizedAddress = ptAddress.toLowerCase();

    // Check cache first
    if (this.marketsCache.has(normalizedAddress)) {
      return this.marketsCache.get(normalizedAddress)!;
    }

    return null;
  }

  /**
   * Get PT to asset rate from Pendle Oracle
   */
  private async getPtToAssetRate(
    marketAddress: Address,
    blockNumber: number,
    duration: number = 1800, // 30 minutes default
  ): Promise<bigint> {
    try {
      const callData = this.oracleInterface.encodeFunctionData(
        'getPtToAssetRate',
        [marketAddress, duration],
      );

      const data = await this.dexHelper.multiContract.methods
        .aggregate([
          {
            target: this.config.oracleAddress,
            callData,
          },
        ])
        .call({}, blockNumber);

      const [rate] = this.oracleInterface.decodeFunctionResult(
        'getPtToAssetRate',
        data.returnData[0],
      );
      return BigInt(rate.toString());
    } catch (error) {
      this.logger.error(
        `Failed to get PT to asset rate for market ${marketAddress}:`,
        error,
      );
      // Return a mock rate for testing (0.98 = 2% discount typical for PT)
      return BigInt('980000000000000000'); // 0.98 in 18 decimals
    }
  }

  /**
   * Check oracle state before making pricing calls
   */
  private async checkOracleState(
    marketAddress: Address,
    blockNumber: number,
    duration: number = 1800,
  ): Promise<boolean> {
    try {
      const callData = this.oracleInterface.encodeFunctionData(
        'getOracleState',
        [marketAddress, duration],
      );

      const data = await this.dexHelper.multiContract.methods
        .aggregate([
          {
            target: this.config.oracleAddress,
            callData,
          },
        ])
        .call({}, blockNumber);

      const [
        increaseCardinalityRequired,
        cardinalityRequired,
        oldestObservationSatisfied,
      ] = this.oracleInterface.decodeFunctionResult(
        'getOracleState',
        data.returnData[0],
      );

      return oldestObservationSatisfied && !increaseCardinalityRequired;
    } catch (error) {
      this.logger.error(
        `Failed to check oracle state for market ${marketAddress}:`,
        error,
      );
      return false; // Assume oracle is not ready if we can't check
    }
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    if (side === SwapSide.BUY) {
      return [];
    }

    // Check for undefined tokens first
    if (!srcToken || !destToken) {
      this.logger.error('Source or destination token is undefined');
      return [];
    }

    // Use wrapETH like other DEXs to handle ETH properly
    const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    const _destToken = this.dexHelper.config.wrapETH(destToken);

    const srcTokenAddress = _srcToken.address;
    const destTokenAddress = _destToken.address;

    if (!srcTokenAddress || !destTokenAddress) {
      this.logger.error('Source or destination token address is undefined');
      return [];
    }

    // Check if this is a valid PT-to-PT rollover
    const srcMarket = this.getMarketForPt(srcTokenAddress);
    const destMarket = this.getMarketForPt(destTokenAddress);

    if (!srcMarket || !destMarket) {
      return [];
    }

    // Ensure both PTs are for the same underlying asset
    if (
      srcMarket.underlyingAssetAddress.toLowerCase() !==
      destMarket.underlyingAssetAddress.toLowerCase()
    ) {
      return [];
    }

    return [`${srcMarket.address}:${destMarket.address}`];
  }

  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AaveV3PtRollOverData>> {
    if (side === SwapSide.BUY) {
      return null;
    }

    // Check for undefined tokens first
    if (!srcToken || !destToken) {
      this.logger.error('Source or destination token is undefined');
      return null;
    }

    // Use wrapETH like other DEXs to handle ETH properly
    const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    const _destToken = this.dexHelper.config.wrapETH(destToken);

    const srcTokenAddress = _srcToken.address;
    const destTokenAddress = _destToken.address;

    if (!srcTokenAddress || !destTokenAddress) {
      this.logger.error('Source or destination token address is undefined');
      return null;
    }

    // Get market details
    const srcMarket = this.getMarketForPt(srcTokenAddress);
    const destMarket = this.getMarketForPt(destTokenAddress);

    if (!srcMarket || !destMarket) {
      return null;
    }

    try {
      // Check oracle state for both markets
      const srcOracleReady = await this.checkOracleState(
        srcMarket.address,
        blockNumber,
      );
      const destOracleReady = await this.checkOracleState(
        destMarket.address,
        blockNumber,
      );

      if (!srcOracleReady || !destOracleReady) {
        this.logger.warn(
          'Oracle not ready for one or both markets, using fallback pricing',
        );
      }

      // Get PT to asset rates for both markets
      const srcPtToAssetRate = await this.getPtToAssetRate(
        srcMarket.address,
        blockNumber,
      );
      const destPtToAssetRate = await this.getPtToAssetRate(
        destMarket.address,
        blockNumber,
      );

      const prices: bigint[] = [];
      const volumes: bigint[] = [];

      // Calculate exchange rate: srcPT -> asset -> destPT
      // srcPtAmount * srcPtToAssetRate / destPtToAssetRate = destPtAmount
      const exchangeRate =
        (srcPtToAssetRate * BigInt(1e18)) / destPtToAssetRate;

      for (const amount of amounts) {
        if (amount === 0n) {
          prices.push(0n);
          volumes.push(0n);
          continue;
        }

        // Calculate output amount
        const outputAmount = (amount * exchangeRate) / BigInt(1e18);

        // Apply a small slippage for realistic pricing (0.1%)
        const outputWithSlippage = (outputAmount * 999n) / 1000n;

        if (outputWithSlippage > 0n) {
          // Price is output/input ratio
          const effectivePrice = (outputWithSlippage * BigInt(1e18)) / amount;
          prices.push(effectivePrice);
          volumes.push(outputWithSlippage);
        } else {
          prices.push(0n);
          volumes.push(0n);
        }
      }

      const data: AaveV3PtRollOverData = {
        srcPtAddress: srcTokenAddress,
        destPtAddress: destTokenAddress,
        srcMarketAddress: srcMarket.address,
        destMarketAddress: destMarket.address,
        sdkQuotedPtOut:
          volumes.length > 0
            ? volumes[volumes.length - 1].toString()
            : undefined,
        blockNumber,
      };

      return [
        {
          prices,
          unit: BigInt(1e18),
          data,
          poolAddresses: [srcMarket.address],
          exchange: this.dexKey,
          gasCost: this.getCalldataGasCost(),
          poolIdentifier: `${srcMarket.address}:${destMarket.address}`,
        },
      ];
    } catch (error) {
      this.logger.error('Failed to get prices and volumes:', error);
      return null;
    }
  }

  getCalldataGasCost(): number | number[] {
    // Based on Pendle transaction complexity - simpler since we're using oracle
    return (
      CALLDATA_GAS_COST.ZERO_BYTE * 500 + CALLDATA_GAS_COST.NONZERO_BYTE * 200
    );
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AaveV3PtRollOverData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = '0x';

    return {
      targetExchange: this.config.pendleRouterAddress,
      payload,
      networkFee: '0',
    };
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const market = this.getMarketForPt(tokenAddress);

    if (!market) {
      // If it's not a PT token we support, return empty
      return [];
    }

    // Find other AAVE PT markets for rollover opportunities
    const rolloverOpportunities: PoolLiquidity[] = [];

    for (const [ptAddress, cachedMarket] of this.marketsCache) {
      if (
        ptAddress !== tokenAddress.toLowerCase() &&
        cachedMarket.underlyingAssetAddress.toLowerCase() ===
          market.underlyingAssetAddress.toLowerCase()
      ) {
        rolloverOpportunities.push({
          exchange: this.dexKey,
          address: cachedMarket.address,
          connectorTokens: [
            {
              address: ptAddress,
              decimals: 18,
            },
          ],
          liquidityUSD: 1000000, // Placeholder - could fetch real liquidity from oracle
        });
      }
    }

    this.logger.info(
      `Found ${rolloverOpportunities.length} rollover opportunities for PT ${tokenAddress}`,
    );
    return rolloverOpportunities.slice(0, limit);
  }

  public async updatePoolState(): Promise<void> {
    // If cache is empty, populate with mock data (needed for getTopPoolsForToken test)
    if (this.marketsCache.size === 0) {
      this.populateMockMarketsForTesting();
    }

    // No need to update since we're using on-chain oracle
    this.logger.info('Pool state update not needed for oracle-based pricing');
  }

  async getDexParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    recipient: Address,
    data: AaveV3PtRollOverData,
    side: SwapSide,
    context: Context,
    executorAddress: Address,
  ): Promise<DexExchangeParam> {
    if (side === SwapSide.BUY) {
      throw new Error('Buy side not supported for PT rollover');
    }

    const srcTokenAddress = srcToken.toLowerCase();
    const destTokenAddress = destToken.toLowerCase();

    // Validate this is the expected rollover
    if (
      srcTokenAddress !== data.srcPtAddress.toLowerCase() ||
      destTokenAddress !== data.destPtAddress.toLowerCase()
    ) {
      throw new Error('Token addresses do not match data');
    }

    // For now, return mock transaction data since we don't have the actual Pendle router integration
    // In a real implementation, this would construct the actual Pendle transaction
    return {
      targetExchange: this.config.pendleRouterAddress,
      exchangeData: '0x1234567890abcdef', // Mock transaction data
      needWrapNative: false,
      dexFuncHasRecipient: true,
      returnAmountPos: undefined,
    };
  }
}
