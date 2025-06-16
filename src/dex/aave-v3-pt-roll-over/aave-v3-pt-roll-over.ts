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
import PENDLE_ORACLE_ABI from '../../abi/PendleOracle.json';

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
    // Try to fetch real market data from Pendle API
    await this.fetchRealMarketData();
    this.logger.info('Successfully initialized Pendle markets cache');
  }

  /**
   * Fetch real market data from Pendle API - Use static configuration for now
   * Note: Market discovery endpoints may require authentication
   */
  private async fetchRealMarketData(): Promise<void> {
    // For now, use static configuration since market discovery endpoints
    // may require authentication or different API structure
    this.logger.info(
      'Using static market configuration for Pendle integration',
    );
    this.populateFallbackMarkets();
  }

  /**
   * Populate markets from static configuration when API is unavailable
   * This uses the actual market addresses from the configuration, not mock data
   */
  private populateFallbackMarkets(): void {
    const configuredMarkets: PendleSDKMarket[] = [
      {
        address: this.config.oldMarketAddress,
        ptAddress: this.config.oldPtAddress.address,
        ytAddress: '0x0000000000000000000000000000000000000000', // YT address not needed for rollover
        underlyingAssetAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', // sUSDe address
        name: 'PT sUSDe 29 May 2025',
        expiry: 1748476800, // May 29, 2025
        chainId: this.config.chainId,
      },
      {
        address: this.config.newMarketAddress,
        ptAddress: this.config.newPtAddress.address,
        ytAddress: '0x0000000000000000000000000000000000000000', // YT address not needed for rollover
        underlyingAssetAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', // sUSDe address
        name: 'PT sUSDe 31 Jul 2025',
        expiry: 1753574400, // July 31, 2025
        chainId: this.config.chainId,
      },
    ];

    configuredMarkets.forEach(market => {
      this.marketsCache.set(market.ptAddress.toLowerCase(), market);
    });

    this.logger.info(
      `Populated ${this.marketsCache.size} markets from static configuration`,
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
   * Batch all oracle calls using multicall for better performance
   */
  private async batchOracleCallsMulticall(
    srcMarketAddress: Address,
    destMarketAddress: Address,
    blockNumber: number,
    duration: number = 1800,
  ): Promise<[boolean, boolean, bigint, bigint]> {
    try {
      // Prepare all calls
      const calls = [
        // Source market oracle state check
        {
          target: this.config.oracleAddress,
          callData: this.oracleInterface.encodeFunctionData('getOracleState', [
            srcMarketAddress,
            duration,
          ]),
        },
        // Destination market oracle state check
        {
          target: this.config.oracleAddress,
          callData: this.oracleInterface.encodeFunctionData('getOracleState', [
            destMarketAddress,
            duration,
          ]),
        },
        // Source market PT to asset rate
        {
          target: this.config.oracleAddress,
          callData: this.oracleInterface.encodeFunctionData(
            'getPtToAssetRate',
            [srcMarketAddress, duration],
          ),
        },
        // Destination market PT to asset rate
        {
          target: this.config.oracleAddress,
          callData: this.oracleInterface.encodeFunctionData(
            'getPtToAssetRate',
            [destMarketAddress, duration],
          ),
        },
      ];

      // Execute all calls in one multicall
      const data = await this.dexHelper.multiContract.methods
        .aggregate(calls)
        .call({}, blockNumber);

      // Decode results
      const [
        srcOracleStateResult,
        destOracleStateResult,
        srcRateResult,
        destRateResult,
      ] = data.returnData;

      // Decode source oracle state
      const [srcIncreaseCardinalityRequired, , srcOldestObservationSatisfied] =
        this.oracleInterface.decodeFunctionResult(
          'getOracleState',
          srcOracleStateResult,
        );
      const srcOracleReady =
        srcOldestObservationSatisfied && !srcIncreaseCardinalityRequired;

      // Decode destination oracle state
      const [
        destIncreaseCardinalityRequired,
        ,
        destOldestObservationSatisfied,
      ] = this.oracleInterface.decodeFunctionResult(
        'getOracleState',
        destOracleStateResult,
      );
      const destOracleReady =
        destOldestObservationSatisfied && !destIncreaseCardinalityRequired;

      // Decode rates
      const [srcRate] = this.oracleInterface.decodeFunctionResult(
        'getPtToAssetRate',
        srcRateResult,
      );
      const [destRate] = this.oracleInterface.decodeFunctionResult(
        'getPtToAssetRate',
        destRateResult,
      );

      return [
        srcOracleReady,
        destOracleReady,
        BigInt(srcRate.toString()),
        BigInt(destRate.toString()),
      ];
    } catch (error) {
      this.logger.error('Failed to batch oracle calls:', error);
      throw error; // Propagate error instead of using fallback values
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
      // Batch all oracle calls using multicall for better performance
      const [
        srcOracleReady,
        destOracleReady,
        srcPtToAssetRate,
        destPtToAssetRate,
      ] = await this.batchOracleCallsMulticall(
        srcMarket.address,
        destMarket.address,
        blockNumber,
      );

      if (!srcOracleReady || !destOracleReady) {
        this.logger.warn(
          'Oracle not ready for one or both markets, using fallback pricing',
        );
      }

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
    // If cache is empty, try to fetch real market data
    if (this.marketsCache.size === 0) {
      await this.fetchRealMarketData();
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

    // Call Pendle SDK roll-over-pt endpoint for PT rollover
    const rollOverParams = {
      receiver: recipient,
      slippage: this.config.defaultSlippageForQuoting,
      dstMarket: data.destMarketAddress,
      ptAmount: srcAmount,
    };

    this.logger.info(
      'Calling Pendle SDK roll-over-pt API for PT rollover:',
      rollOverParams,
    );

    const response = await this.callPendleSdkApi(
      `/v1/sdk/${this.config.chainId}/markets/${data.srcMarketAddress}/roll-over-pt`,
      rollOverParams,
    );

    if (!response.success) {
      throw new Error(
        `Pendle SDK roll-over-pt endpoint failed: ${
          response.error || 'No transaction data returned'
        }`,
      );
    }

    // Extract transaction data from response
    const txData = response.tx || response.data?.tx || response.data;

    if (!txData || !txData.to || !txData.data) {
      throw new Error(
        `Pendle SDK response missing transaction data. Response: ${JSON.stringify(
          response,
        )}`,
      );
    }

    // Extract additional response data
    const responseData = response.data || response;

    this.logger.info('Pendle SDK transaction constructed successfully:', {
      to: txData.to,
      dataLength: txData.data?.length,
      value: txData.value,
      amountLpOut: responseData.amountLpOut,
      priceImpact: responseData.priceImpact,
    });

    return {
      targetExchange: txData.to, // This should be the Pendle Router address
      exchangeData: txData.data, // The actual encoded transaction data
      needWrapNative: false,
      dexFuncHasRecipient: true,
      returnAmountPos: undefined, // Pendle handles return amount internally
    };
  }

  /**
   * Call Pendle SDK API for transaction construction
   */
  private async callPendleSdkApi(endpoint: string, params: any): Promise<any> {
    try {
      // Build URL with query parameters for GET requests
      const url = new URL(`${this.config.pendleSdkBaseUrl}${endpoint}`);
      Object.keys(params).forEach(key => {
        if (params[key] !== undefined && params[key] !== null) {
          url.searchParams.append(key, params[key].toString());
        }
      });

      this.logger.info(`Calling Pendle SDK: ${url.toString()}`);
      this.logger.debug(`Request params:`, params);

      const response = await this.dexHelper.httpRequest.get(
        url.toString(),
        30000, // 30 second timeout
        {
          Accept: 'application/json',
        },
      );

      this.logger.debug(`Response received:`, response);

      const responseData = response as any;
      return {
        success: true,
        data: responseData.data || responseData, // Handle different response structures
        tx: responseData.tx || responseData.data?.tx, // Extract transaction data
      };
    } catch (error: any) {
      this.logger.error(`Pendle SDK API call failed for ${endpoint}:`, error);

      // Log more details about the error
      if (error.response) {
        this.logger.error(`Response status: ${error.response.status}`);
        this.logger.error(`Response data:`, error.response.data);
      }

      return {
        success: false,
        error: error?.message || 'Unknown error',
        data: null,
      };
    }
  }
}
