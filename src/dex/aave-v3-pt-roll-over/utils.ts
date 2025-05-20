import { Contract } from 'web3-eth-contract';
import { Interface } from '@ethersproject/abi';
import { PoolState } from './types';

export async function getOnChainState(
  multiContract: Contract,
  oracleAddress: string,
  marketAddress: string,
  oracleInterface: Interface,
  blockNumber: number | 'latest',
): Promise<PoolState> {
  const duration = 900; // value taken from the Pendle docs https://docs.pendle.finance/Developers/Oracles/HowToIntegratePtAndLpOracle
  const data: { returnData: any[] } = await multiContract.methods
    .aggregate([
      {
        target: oracleAddress,
        callData: oracleInterface.encodeFunctionData(
          'getPtToSyRate(address,uint32)',
          [marketAddress, duration],
        ),
      },
    ])
    .call({}, blockNumber);

  const price = BigInt(
    oracleInterface.decodeFunctionResult(
      'getPtToSyRate(address,uint32)',
      data.returnData[0],
    )[0],
  );

  return {
    price,
  };
}
