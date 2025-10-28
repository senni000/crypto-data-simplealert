import { DatabaseManager } from '../database';
import { AlertManager } from '../alert-manager';
import { OptionData, TradeData } from '../../types';

describe('System Integration', () => {
  jest.setTimeout(10000);

  describe('CP Delta Alert Flow', () => {
    it('persists alert history after Discord delivery', async () => {
      const databaseManager = new DatabaseManager(':memory:');
      await databaseManager.initializeDatabase();

      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };
      const alertManager = new AlertManager(databaseManager, {
        webhookUrl: 'https://discord.com/api/webhooks/test',
        httpClient,
        cpPeriod: 2,
        cpChangeThreshold: 0.02,
        cpCooldownMinutes: 0,
      });

      const baseOption: Omit<OptionData, 'delta' | 'symbol'> = {
        timestamp: Date.now(),
        underlyingPrice: 50000,
        markPrice: 1500,
        impliedVolatility: 0.6,
        gamma: 0.001,
        theta: -10,
        vega: 45,
        rho: 3,
      };

      const firstBatch: OptionData[] = [
        { ...baseOption, symbol: 'BTC-C1', delta: 0.22 },
        { ...baseOption, symbol: 'BTC-C2', delta: 0.24 },
        { ...baseOption, symbol: 'BTC-P1', delta: -0.21 },
        { ...baseOption, symbol: 'BTC-P2', delta: -0.27 },
      ];

      const secondBatch: OptionData[] = [
        { ...baseOption, symbol: 'BTC-C-HIGH1', delta: 0.5 },
        { ...baseOption, symbol: 'BTC-C-HIGH2', delta: 0.48 },
        { ...baseOption, symbol: 'BTC-P-HIGH1', delta: -0.05 },
        { ...baseOption, symbol: 'BTC-P-HIGH2', delta: -0.08 },
      ];

      await alertManager.checkCPDelta25Alert(firstBatch);
      await alertManager.checkCPDelta25Alert(secondBatch);

      expect(httpClient.post).toHaveBeenCalledTimes(1);

      const alerts = await databaseManager.getRecentAlerts('CP_DELTA_25', 60);
      expect(alerts).toHaveLength(1);

      await databaseManager.closeDatabase();
    });
  });

  describe('CVD Alert Flow', () => {
    it('stores CVD history and raises alerts when threshold exceeded', async () => {
      const databaseManager = new DatabaseManager(':memory:');
      await databaseManager.initializeDatabase();

      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };
      const alertManager = new AlertManager(databaseManager, {
        webhookUrl: 'https://discord.com/api/webhooks/test',
        httpClient,
        cvdThreshold: 1.5,
        cvdCooldownMinutes: 0,
      });

      const baseTimestamp = Date.now() - 60 * 60 * 1000;
      await databaseManager.saveCVDData({ timestamp: baseTimestamp, cvdValue: 5, zScore: 0 });
      await databaseManager.saveCVDData({ timestamp: baseTimestamp + 1000, cvdValue: 6, zScore: 0 });
      await databaseManager.saveCVDData({ timestamp: baseTimestamp + 2000, cvdValue: 7, zScore: 0 });

      const trades: TradeData[] = [
        {
          symbol: 'BTC-PERPETUAL',
          timestamp: Date.now(),
          price: 45000,
          amount: 4,
          direction: 'buy',
          tradeId: 'trade-1',
        },
        {
          symbol: 'BTC-PERPETUAL',
          timestamp: Date.now(),
          price: 45010,
          amount: 3,
          direction: 'buy',
          tradeId: 'trade-2',
        },
      ];

      await alertManager.checkCVDAlert(trades);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      const cvdAlerts = await databaseManager.getRecentAlerts('CVD_ZSCORE', 60);
      expect(cvdAlerts).toHaveLength(1);

      const storedCvd = await databaseManager.getCVDDataLast24Hours();
      expect(storedCvd.length).toBeGreaterThanOrEqual(4);

      await databaseManager.closeDatabase();
    });
  });
});
