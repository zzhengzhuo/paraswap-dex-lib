import * as _ from 'lodash';
import {
  DummyDexHelper,
  DummyLimitOrderProvider,
  IDexHelper,
} from '../dex-helper';
import BigNumber from 'bignumber.js';
import { PricingHelper } from '../pricing-helper';
import { DexAdapterService } from '../dex';
import {
  Address,
  OptimalRate,
  Token,
  TransferFeeParams,
  TxObject,
} from '../types';
import { ContractMethod, Network, NULL_ADDRESS } from '../constants';
import { LimitOrderExchange } from '../dex/limit-order-exchange';
import { v4 as uuid } from 'uuid';
import {
  DirectContractMethods,
  SwapSide,
} from '@paraswap/core/build/constants';
import { GenericSwapTransactionBuilder } from '../generic-swap-transaction-builder';
import { AddressOrSymbol } from '@paraswap/sdk';
import { NumberAsString, ParaSwapVersion } from '@paraswap/core';
import { TransactionBuilder } from '../transaction-builder';
import { UniswapV3EventPool } from '../dex/uniswap-v3/uniswap-v3-pool';
import { UniswapV3 } from '../dex/uniswap-v3/uniswap-v3';
import { CallBack } from '../dex-helper/idex-helper';
import { BlockCallback } from '../dex-helper/dummy-dex-helper';
import { uniswapV3Math } from '../dex/uniswap-v3/contract-math/uniswap-v3-math';

export interface IParaSwapSDK {
  getPrices(
    from: Token,
    to: Token,
    amount: bigint,
    side: SwapSide,
    contractMethod: ContractMethod,
    _poolIdentifiers?: { [key: string]: string[] | null } | null,
    transferFees?: TransferFeeParams,
    forceRoute?: AddressOrSymbol[],
  ): Promise<OptimalRate>;

  buildTransaction(
    priceRoute: OptimalRate,
    minMaxAmount: BigInt,
    userAddress: Address,
  ): Promise<TxObject>;

  initializePricing?(): Promise<void>;

  releaseResources?(): Promise<void>;

  dexHelper?: IDexHelper & {
    replaceProviderWithRPC?: (rpcUrl: string) => void;
  };
}

const chunks = 10;

export class LocalParaswapSDK implements IParaSwapSDK {
  dexHelper: DummyDexHelper;
  dexAdapterService: DexAdapterService;
  pricingHelper: PricingHelper;
  dexKeys: string[];
  transactionBuilder: GenericSwapTransactionBuilder;
  transactionBuilderV5: TransactionBuilder;

  constructor(
    protected network: number,
    dexKeys: string | string[],
    rpcUrl: string,
    blockNumber: number,
    callBack: CallBack,
    blockCallback: BlockCallback,
    preloadPools: Map<
      string,
      { token0: Address; token1: Address; fee: bigint }[]
    >,
    limitOrderProvider?: DummyLimitOrderProvider,
  ) {
    this.dexHelper = new DummyDexHelper(
      this.network,
      blockNumber,
      rpcUrl,
      callBack,
      blockCallback,
      preloadPools,
    );
    this.dexAdapterService = new DexAdapterService(
      this.dexHelper,
      this.network,
    );
    this.pricingHelper = new PricingHelper(
      this.dexAdapterService,
      this.dexHelper.getLogger,
    );
    this.transactionBuilder = new GenericSwapTransactionBuilder(
      this.dexAdapterService,
    );
    this.transactionBuilderV5 = new TransactionBuilder(this.dexAdapterService);

    this.dexKeys = Array.isArray(dexKeys) ? dexKeys : [dexKeys];
    this.dexKeys.map(dexKey => {
      try {
        const dex = this.dexAdapterService.getDexByKey(dexKey);

        if (limitOrderProvider && dex instanceof LimitOrderExchange) {
          dex.limitOrderProvider = limitOrderProvider;
        }
      } catch (e) {
        // only for testing
        delete this.dexKeys[this.dexKeys.indexOf(dexKey)];
      }
    });
  }

  getUniswapV3HolderAmounts(
    currentTick: bigint,
    currentPrice: bigint,
    startTickBitmap: bigint,
    tickBitmap: Record<NumberAsString, bigint>,
    networkId: number,
    ticks: Map<
      NumberAsString,
      { liquidityGross: bigint; liquidityNet: bigint }
    >,
    tickSpacing: bigint,
    liquidity: bigint,
  ): Map<
    NumberAsString,
    { amount0: bigint; amount1: bigint; liquidity: bigint }
  > {
    return uniswapV3Math.getHolderAmounts(
      currentTick,
      currentPrice,
      startTickBitmap,
      tickBitmap,
      networkId,
      ticks,
      tickSpacing,
      liquidity,
    );
  }

  async getDexPool(
    dexKey: string,
    address: Address,
  ): Promise<UniswapV3EventPool | null> {
    const dex = this.dexAdapterService.getDexByKey(dexKey) as UniswapV3;
    const blockNumber = this.dexHelper.blockManager.getLatestBlockNumber();
    const pool = await dex.getPoolByAddress(address, blockNumber);
    return pool;
  }

  async getDexPoolInfo(dexKey: string, address: Address) {
    const dex = this.dexAdapterService.getDexByKey(dexKey) as UniswapV3;
    return dex.getPoolInfo(address);
  }

  async initializePricing() {
    await this.dexHelper.init();
    const blockNumber = this.dexHelper.blockManager.getLatestBlockNumber();
    await this.pricingHelper.initialize(blockNumber, this.dexKeys);
    this.dexHelper.blockManager.updateBlock();
  }

  async releaseResources() {
    await this.pricingHelper.releaseResources(this.dexKeys);
  }

  async getPrices(
    from: Token,
    to: Token,
    amount: bigint,
    side: SwapSide,
    contractMethod: ContractMethod,
    _poolIdentifiers?: { [key: string]: string[] | null } | null,
    transferFees?: TransferFeeParams,
    forceRoute?: AddressOrSymbol[],
  ): Promise<OptimalRate> {
    const blockNumber = await this.dexHelper.provider.getBlockNumber();
    const poolIdentifiers =
      _poolIdentifiers ||
      (await this.pricingHelper.getPoolIdentifiers(
        from,
        to,
        side,
        blockNumber,
        this.dexKeys,
      ));

    const amounts = _.range(0, chunks + 1).map(
      i => (amount * BigInt(i)) / BigInt(chunks),
    );
    const poolPrices = await this.pricingHelper.getPoolPrices(
      from,
      to,
      amounts,
      side,
      blockNumber,
      this.dexKeys,
      poolIdentifiers,
      transferFees,
    );

    if (!poolPrices || poolPrices.length == 0)
      throw new Error('Fail to get price for ' + this.dexKeys.join(', '));

    const finalPrice = poolPrices[0];
    const quoteAmount = finalPrice.prices[chunks];
    const srcAmount = (
      side === SwapSide.SELL ? amount : quoteAmount
    ).toString();
    const destAmount = (
      side === SwapSide.SELL ? quoteAmount : amount
    ).toString();

    // eslint-disable-next-line no-console
    console.log(
      `Estimated gas cost for ${this.dexKeys}: ${
        Array.isArray(finalPrice.gasCost)
          ? finalPrice.gasCost[finalPrice.gasCost.length - 1]
          : finalPrice.gasCost
      }`,
    );

    const unoptimizedRate = {
      blockNumber,
      network: this.network,
      srcToken: from.address,
      srcDecimals: from.decimals,
      srcAmount,
      destToken: to.address,
      destDecimals: to.decimals,
      destAmount,
      bestRoute: [
        {
          percent: 100,
          swaps: [
            {
              srcToken: from.address,
              srcDecimals: from.decimals,
              destToken: to.address,
              destDecimals: to.decimals,
              swapExchanges: [
                {
                  exchange: finalPrice.exchange,
                  srcAmount,
                  destAmount,
                  percent: 100,
                  data: finalPrice.data,
                  poolAddresses: finalPrice.poolAddresses,
                },
              ],
            },
          ],
        },
      ],
      gasCostUSD: '0',
      gasCost: '0',
      others: [],
      side,
      // For V5 tests, put Augustus V5 address here
      // contractAddress: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57',
      contractAddress: '0x6a000f20005980200259b80c5102003040001068',
      tokenTransferProxy: '',
      // For V5 tests, put V5 version here
      // version: ParaSwapVersion.V5,
      version: ParaSwapVersion.V6,
    };

    const optimizedRate = this.pricingHelper.optimizeRate(unoptimizedRate);

    return {
      ...optimizedRate,
      hmac: '0',
      srcUSD: '0',
      destUSD: '0',
      contractMethod,
      partnerFee: 0,
    };
  }

  async buildTransaction(
    priceRoute: OptimalRate,
    minMaxAmount: BigInt,
    userAddress: Address,
  ) {
    // Set deadline to be 10 min from now
    let deadline = Number((Math.floor(Date.now() / 1000) + 10 * 60).toFixed());

    const slippageFactor = new BigNumber(minMaxAmount.toString()).div(
      priceRoute.side === SwapSide.SELL
        ? priceRoute.destAmount
        : priceRoute.srcAmount,
    );

    const contractMethod = priceRoute.contractMethod;
    const executionContractAddress =
      this.transactionBuilder.getExecutionContractAddress(priceRoute);

    // Call preprocessTransaction for each exchange before we build transaction
    try {
      priceRoute.bestRoute = await Promise.all(
        priceRoute.bestRoute.map(async (route, routeIndex) => {
          route.swaps = await Promise.all(
            route.swaps.map(async (swap, swapIndex) => {
              swap.swapExchanges = await Promise.all(
                swap.swapExchanges.map(async se => {
                  // Search in dexLib dexes
                  const dexLibExchange = this.pricingHelper.getDexByKey(
                    se.exchange,
                  );

                  const dex = this.dexAdapterService.getTxBuilderDexByKey(
                    se.exchange,
                  );

                  if (dexLibExchange && dexLibExchange.preProcessTransaction) {
                    if (!dexLibExchange.getTokenFromAddress) {
                      throw new Error(
                        'If you want to test preProcessTransaction, first need to implement getTokenFromAddress function',
                      );
                    }

                    const { recipient } =
                      priceRoute.version === ParaSwapVersion.V5
                        ? this.transactionBuilderV5.getDexCallsParams(
                            priceRoute,
                            routeIndex,
                            swap,
                            swapIndex,
                            se,
                            minMaxAmount.toString(),
                            dex,
                            executionContractAddress,
                          )
                        : this.transactionBuilder.getDexCallsParams(
                            priceRoute,
                            routeIndex,
                            swap,
                            swapIndex,
                            se,
                            minMaxAmount.toString(),
                            dex,
                            executionContractAddress,
                          );

                    const [preprocessedRoute, txInfo] =
                      await dexLibExchange.preProcessTransaction(
                        se,
                        dexLibExchange.getTokenFromAddress(swap.srcToken),
                        dexLibExchange.getTokenFromAddress(swap.destToken),
                        priceRoute.side,
                        {
                          slippageFactor,
                          txOrigin: userAddress,
                          userAddress,
                          executionContractAddress,
                          isDirectMethod: DirectContractMethods.includes(
                            contractMethod as ContractMethod,
                          ),
                          version: priceRoute.version,
                          recipient,
                        },
                      );

                    deadline =
                      txInfo.deadline && Number(txInfo.deadline) < deadline
                        ? Number(txInfo.deadline)
                        : deadline;

                    return preprocessedRoute;
                  }
                  return se;
                }),
              );
              return swap;
            }),
          );
          return route;
        }),
      );
    } catch (e) {
      throw e;
    }

    const txBuilder: TransactionBuilder | GenericSwapTransactionBuilder =
      priceRoute.version === ParaSwapVersion.V5
        ? this.transactionBuilderV5
        : this.transactionBuilder;

    return await txBuilder.build({
      priceRoute,
      minMaxAmount: minMaxAmount.toString(),
      userAddress,
      partnerAddress: NULL_ADDRESS,
      partnerFeePercent: '0',
      deadline: deadline.toString(),
      uuid: uuid(),
    });
  }
}
