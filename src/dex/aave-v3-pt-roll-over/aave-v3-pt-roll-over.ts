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
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { AaveV3PtRollOverData, DexParams } from './types';
import { SimpleExchange } from '../simple-exchange';
import { AaveV3PtRollOverConfig } from './config';
import PendleRouterABI from '../../abi/PendleRouter.json';

import { ethers, Contract, BigNumber, Signer } from 'ethers';

export class AaveV3PtRollOver
  extends SimpleExchange
  implements IDex<AaveV3PtRollOverData>
{
  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = false;
  readonly isFeeOnTransferSupported = false;

  private config: DexParams;
  private pendleRouter: Contract;

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

    this.pendleRouter = new ethers.Contract(
      this.config.pendleRouterAddress,
      PendleRouterABI,
      this.dexHelper.provider,
    );
  }

  getAdapters(): { name: string; index: number }[] | null {
    return null;
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const srcTokenAddress = srcToken.address?.toLowerCase();
    const destTokenAddress = destToken.address?.toLowerCase();

    if (!srcTokenAddress || !destTokenAddress) {
      this.logger.error('Source or destination token address is undefined');
      return [];
    }

    if (
      srcTokenAddress === this.config.oldPtAddress.toLowerCase() &&
      destTokenAddress === this.config.newPtAddress.toLowerCase()
    ) {
      {
        return [
          `${this.config.oldMarketAddress}:${this.config.newMarketAddress}`,
        ];
      }
    }

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
    if (side === SwapSide.BUY) {
      return null;
    }

    const srcTokenAddress = srcToken.address?.toLowerCase();
    const destTokenAddress = destToken.address?.toLowerCase();

    if (!srcTokenAddress || !destTokenAddress) {
      this.logger.error('Source or destination token address is undefined');
      return null;
    }

    const isValidSwap =
      srcTokenAddress === this.config.oldPtAddress.toLowerCase() &&
      destTokenAddress === this.config.newPtAddress.toLowerCase();

    if (!isValidSwap) {
      return null;
    }

    const price = BigInt(1e18);
    const unitOut = price;

    const amountsOut = amounts.map(amount => (amount * price) / BigInt(1e18));

    return null;
  }

  getCalldataGasCost(): number | number[] {
    //         Calldata Cost Calculation
    // ZERO_BYTE Cost: 4 gas
    // NONZERO_BYTE Cost: 16 gas
    // Base on an tx example, value returned by Pendle API:
    // Zero Bytes: 1081
    //         Non - Zero Bytes: 363
    // The total calldata cost is:
    //         (1081×4) +(363×16)=4324 + 5808=10132 gas
    return (
      CALLDATA_GAS_COST.ZERO_BYTE * 1081 + CALLDATA_GAS_COST.NONZERO_BYTE * 363
    ); // Placeholder, actual cost is higher
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = '0x';

    return {
      targetExchange: this.config.pendleRouterAddress, // Pendle Router Address
      payload,
      networkFee: '0',
    };
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const isOldPt =
      tokenAddress.toLowerCase() === this.config.oldPtAddress.toLowerCase();
    const isNewPt =
      tokenAddress.toLowerCase() === this.config.newPtAddress.toLowerCase();

    if (!isOldPt && !isNewPt) {
      return [];
    }

    return [
      {
        exchange: this.dexKey,
        address: this.config.pendleRouterAddress,
        connectorTokens: [
          {
            address: isOldPt
              ? this.config.oldPtAddress
              : this.config.newPtAddress,
            decimals: 18,
          },
        ],
        liquidityUSD: 1000000000,
      },
    ];
  }

  async getDexParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    recipient: Address,
    side: SwapSide,
  ): Promise<DexExchangeParam> {
    if (side === SwapSide.BUY) {
      this.logger.error('Invalid swap');
    }

    const srcTokenAddress = srcToken.toLowerCase();
    const destTokenAddress = destToken.toLowerCase();

    const isValidSwap =
      srcTokenAddress === this.config.oldPtAddress.toLowerCase() &&
      destTokenAddress === this.config.newPtAddress.toLowerCase();

    if (!isValidSwap) {
      this.logger.error('Invalid swap');
    }

    const amountIn = srcAmount;
    const amountOut = destAmount;

    const calldataGasCost = this.getCalldataGasCost();

    return {
      needWrapNative: false,
      dexFuncHasRecipient: false,
      exchangeData: this.pendleRouter.interface.encodeFunctionData(
        'swapExactTokensForTokens',
        [amountIn, amountOut, recipient],
      ),
      targetExchange: this.config.pendleRouterAddress,
      returnAmountPos: undefined,
    };
  }
}
