import { DatabaseManager } from '../database';
import { AlertManager } from '../alert-manager';
import { AlertQueueProcessor } from '../alert-queue-processor';
import { OptionData, CvdDeltaAlertPayload } from '../../types';

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
    it('dispatches queued payloads via alert processor', async () => {
      const databaseManager = new DatabaseManager(':memory:');
      await databaseManager.initializeDatabase();

      const payload: CvdDeltaAlertPayload = {
        symbol: 'BTC-PERP',
        timestamp: Date.now(),
        bucketSpanMinutes: 5,
        delta: 1.2,
        zScore: 3.1,
        threshold: 2.5,
        direction: 'buy',
        windowHours: 72,
      };

      await databaseManager.enqueueAlert('CVD_DELTA_5M_BUY', payload, payload.timestamp);

      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };
      const alertManager = new AlertManager(databaseManager, {
        webhookUrl: 'https://discord.com/api/webhooks/test',
        httpClient,
        maxRetries: 0,
      });

      const processor = new AlertQueueProcessor(databaseManager, alertManager, {
        pollIntervalMs: 10,
        batchSize: 10,
        maxAttempts: 1,
      });

      const processed = new Promise<void>((resolve) => {
        processor.once('alertSent', () => resolve());
      });

      await processor.start();
      await processed;
      await processor.stop();

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      const cvdAlerts = await databaseManager.getRecentAlerts('CVD_DELTA_5M_BUY', 60);
      expect(cvdAlerts).toHaveLength(1);

      await databaseManager.closeDatabase();
    });
  });
});
