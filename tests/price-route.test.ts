import priceRouteData from './price-route.json';
import { testPriceRoute } from './utils-e2e';
import { OptimalRate } from '@paraswap/core';

describe('Price Route', function () {
  it('should work', async () => {
    await testPriceRoute(priceRouteData.data.priceRoute as OptimalRate);
  });
});
