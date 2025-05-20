import { Interface } from '@ethersproject/abi';
import { BigNumber, ethers } from 'ethers';
import { IDexHelper } from '../../dex-helper';
import { Address, Logger } from '../../types';
import { DeepReadonly } from 'ts-essentials';
import { PoolState, DexParams } from './types';

// Minimal ABI for a Pendle Chainlink oracle.
const MINIMAL_PENDLE_ORACLE_ABI: any[] = [
  'function getPtToSyRate(address,uint32) view returns (uint256)',
];

export class AaveV3PtRollOverPool {
  private dexHelper: IDexHelper;
  private dexParams: DexParams;
  private logger: Logger;
  private oracleInterface?: Interface; // Optional: only if oracle is used

  constructor(dexHelper: IDexHelper, dexParams: DexParams, logger: Logger) {
    this.dexHelper = dexHelper;
    this.dexParams = dexParams;
    this.logger = logger;

    if (this.dexParams.pendleChainlinkOracleAddress) {
      this.oracleInterface = new Interface(MINIMAL_PENDLE_ORACLE_ABI);
    }
  }

  /**
   * Generates the pool state, primarily fetching or calculating a representative "price".
   * The current PoolState is simple: { price: bigint }.
   * This function is responsible for populating state.price.
   * @param blockNumber The block number at which to generate the state.
   */
  async generateState(
    blockNumber: number | 'latest',
  ): Promise<DeepReadonly<PoolState>> {
    const blockTag = blockNumber === 'latest' ? undefined : blockNumber;
    this.logger.info(
      `[AaveV3PtRollOverPool] Generating state for block ${
        blockTag || 'latest'
      }`,
    );

    let calculatedPrice = BigInt(0);

    if (this.dexParams.pendleChainlinkOracleAddress && this.oracleInterface) {
      try {
        const oracleContract = new ethers.Contract(
          this.dexParams.pendleChainlinkOracleAddress,
          this.oracleInterface,
          this.dexHelper.provider,
        );

        const [priceFromOracle, oracleDecimals] = await Promise.all([
          oracleContract.getPtToSyRate(this.dexParams.oldMarketAddress, 900, {
            blockTag,
          }),
          oracleContract.getPtToSyRate(this.dexParams.newMarketAddress, 900, {
            blockTag,
          }),
        ]);

        // Adjust price by oracle decimals to get a common representation (e.g., 18 decimals)
        // This example assumes you want to scale it to 18 decimals.
        const priceBigNumber = BigNumber.from(priceFromOracle.toString());
        calculatedPrice = priceBigNumber
          .mul(BigNumber.from(10).pow(18 - oracleDecimals))
          .toBigInt();

        this.logger.info(
          `[AaveV3PtRollOverPool] Raw price from oracle ${
            this.dexParams.pendleChainlinkOracleAddress
          }: ${priceFromOracle.toString()}, decimals: ${oracleDecimals}. Adjusted price (18 dec): ${calculatedPrice.toString()}`,
        );
      } catch (error) {
        this.logger.error(
          `[AaveV3PtRollOverPool] Error fetching price from Chainlink oracle at block ${
            blockTag || 'latest'
          }:`,
          error,
        );
        // Fallback to default price or rethrow, depending on desired behavior
      }
    } else {
      this.logger.error(
        `[AaveV3PtRollOverPool] Error: pendleChainlinkOracleAddress not configured or oracleInterface not initialized.`,
      );
    }

    const state: PoolState = {
      price: calculatedPrice,
    };
    return Object.freeze(state);
  }

  /**
   * Gets the calculated price for the pool at a specific block.
   * @param blockNumber The block number for which to get the price.
   * @returns The calculated price as a bigint.
   */
  async getPrice(blockNumber: number): Promise<bigint> {
    this.logger.info(
      `[AaveV3PtRollOverPool] Getting price for block ${blockNumber}`,
    );
    const state = await this.generateState(blockNumber);
    if (state.price === undefined) {
      const errorMessage = `[AaveV3PtRollOverPool] Price is undefined in generated state for block ${blockNumber}. Check generateState logic and oracle configuration.`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    this.logger.info(
      `[AaveV3PtRollOverPool] Price for block ${blockNumber}: ${state.price.toString()}`,
    );
    return state.price;
  }
}
