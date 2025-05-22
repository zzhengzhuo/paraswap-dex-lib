import { Address } from '../../types';
import { BigNumber } from 'ethers';

export type AaveV3PtRollOverData = {};

export type DexParams = {
  pendleRouterAddress: Address;
  oldPtAddress: Address;
  newPtAddress: Address;
  oldMarketAddress: Address;
  newMarketAddress: Address;
};
