import { DexParams } from './types';
import { DexConfigMap } from '../../types';
import { Network } from '../../constants';

const PENDLE_ROUTER_ADDRESS = '0x888888888889758f76e7103c6cbf23abbf58f946';
const OLD_PT_ADDRESS = '0xb7de5dfcb74d25c2f21841fbd6230355c50d9308';
const OLD_MARKET_ADDRESS = '0xb162b764044697cf03617c2efbcb1f42e31e4766';
const NEW_MARKET_ADDRESS = '0x4339ffe2b7592dc783ed13cce310531ab366deac';
const SUSDE_TOKEN_ADDRESS = '0x9d39a5de30e57443bff2a8307a4256c8797a3497';
const PENDLE_CHAINLINK_ORACLE_ADDRESS =
  '0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2';

export const AaveV3PtRollOverConfig: DexConfigMap<DexParams> = {
  AaveV3PtRollOver: {
    [Network.MAINNET]: {
      pendleRouterAddress: PENDLE_ROUTER_ADDRESS,
      oldPtAddress: OLD_PT_ADDRESS,
      oldMarketAddress: OLD_MARKET_ADDRESS,
      newMarketAddress: NEW_MARKET_ADDRESS,
      sUSDeTokenAddress: SUSDE_TOKEN_ADDRESS,
      pendleChainlinkOracleAddress: PENDLE_CHAINLINK_ORACLE_ADDRESS,
    },
  },
};
