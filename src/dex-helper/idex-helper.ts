import { Provider } from '@ethersproject/providers';
import { LoggerConstructor, NumberAsString } from '../types';
import { ICache } from './icache';
import { IRequestWrapper } from './irequest-wrapper';
import { IBlockManager } from './iblock-manager';
import Web3 from 'web3';
import { Contract } from 'web3-eth-contract';
import { Token } from '../types';
import { ConfigHelper } from '../config';
import { MultiWrapper } from '../lib/multi-wrapper';
import { PromiseScheduler } from '../lib/promise-scheduler';
import { AugustusApprovals } from '../dex/augustus-approvals';
import { Address } from '@paraswap/sdk';

export type CallBack = (
  blockTimestamp: bigint,
  poolAddress: Address,
  txHash: string,
  tradingVolumes: Map<
    NumberAsString,
    {
      amount0: bigint;
      amount1: bigint;
    }
  >,
  balance0: bigint,
  balance1: bigint,
  currentTick: bigint,
  currentPrice: bigint,
  currentLiquidity: bigint,
  tickSpacing: bigint,
  startTickBitmap: bigint,
  tickBitmap: Record<NumberAsString, bigint>,
  networkId: number,
  liquidity: Map<
    NumberAsString,
    { liquidityGross: bigint; liquidityNet: bigint }
  >,
) => void;

export interface IDexHelper {
  config: ConfigHelper;
  cache: ICache;
  httpRequest: IRequestWrapper;
  multiContract: Contract;
  multiWrapper: MultiWrapper;
  augustusApprovals: AugustusApprovals;
  promiseScheduler: PromiseScheduler;
  provider: Provider;
  web3Provider: Web3;
  blockManager: IBlockManager;
  preloadPools: Map<
    string,
    { token0: Address; token1: Address; fee: bigint }[]
  >;
  callBack: CallBack;
  getLogger: LoggerConstructor;
  getTokenUSDPrice: (token: Token, amount: bigint) => Promise<number>;
  getUsdTokenAmounts: (
    tokensAmounts: [token: Address, amount: bigint | null][],
  ) => Promise<number[]>;
}
