import { AlertManager } from '../alert-manager';
import { IDatabaseManager } from '../interfaces';
import {
  OptionData,
  TradeData,
  AlertMessage,
  CVDData,
  AlertHistory,
  CvdDeltaAlertPayload,
  MarketTradeSpikePayload,
} from '../../types';

type MockedDatabaseManager = jest.Mocked<IDatabaseManager>;

const createMockDatabaseManager = (): MockedDatabaseManager => ({
  initializeDatabase: jest.fn().mockResolvedValue(undefined),
  saveTradeData: jest.fn().mockResolvedValue(undefined),
  saveOptionData: jest.fn().mockResolvedValue(undefined),
  getTradeDataLast24Hours: jest.fn().mockResolvedValue([]),
  getLatestOptionData: jest.fn().mockResolvedValue([]),
  saveCVDData: jest.fn().mockResolvedValue(undefined),
  getCVDDataLast24Hours: jest.fn().mockResolvedValue([] as CVDData[]),
  getCvdDataSince: jest.fn().mockResolvedValue([] as CVDData[]),
  saveAlertHistory: jest.fn().mockResolvedValue(undefined),
  getRecentAlerts: jest.fn().mockResolvedValue([]),
  saveOrderFlowRatioData: jest.fn().mockResolvedValue(undefined),
  saveSkewRawData: jest.fn().mockResolvedValue(undefined),
  getOrderFlowRatioSeries: jest.fn().mockResolvedValue([]),
  getSkewRawSeries: jest.fn().mockResolvedValue([]),
  getTradeDataSinceRowId: jest.fn().mockResolvedValue([]),
  getLargeTradeDataSinceRowId: jest.fn().mockResolvedValue([]),
  getLatestTradeCursor: jest.fn().mockResolvedValue(null),
  getProcessingState: jest.fn().mockResolvedValue(null),
  saveProcessingState: jest.fn().mockResolvedValue(undefined),
  enqueueAlert: jest.fn().mockResolvedValue(1),
  getPendingAlerts: jest.fn().mockResolvedValue([]),
  markAlertProcessed: jest.fn().mockResolvedValue(undefined),
  markAlertFailed: jest.fn().mockResolvedValue(undefined),
  hasRecentAlertOrPending: jest.fn().mockResolvedValue(false),
  closeDatabase: jest.fn().mockResolvedValue(undefined),
});

const webhookUrl = 'https://discord.com/api/webhooks/test';

describe('AlertManager', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('sendDiscordAlert', () => {
    it('sends alert content to Discord and records history', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };
      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        maxRetries: 0,
      });

      const message: AlertMessage = {
        type: 'CP_DELTA_25',
        timestamp: Date.now(),
        value: 0.45,
        threshold: 0.05,
        message: 'Test message',
      };

      await manager.sendDiscordAlert(message);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      const [url, payload] = httpClient.post.mock.calls[0];
      expect(url).toContain(webhookUrl);
      expect(payload).toMatchObject({
        content: expect.stringContaining('CP_DELTA_25'),
      });
      expect(db.saveAlertHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: 'CP_DELTA_25',
          value: 0.45,
          message: 'Test message',
        }),
      );
    });

    it('retries failed attempts and throws after exceeding max retries', async () => {
      const db = createMockDatabaseManager();
      const httpClient = {
        post: jest.fn().mockRejectedValue(new Error('Network failure')),
      };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        maxRetries: 1,
        retryDelayMs: 10,
      });

      const message: AlertMessage = {
        type: 'CVD_DELTA',
        timestamp: Date.now(),
        value: 2.5,
        threshold: 2.0,
        message: 'Z-score alert',
      };

      await expect(manager.sendDiscordAlert(message)).rejects.toThrow('Network failure');
      expect(httpClient.post).toHaveBeenCalledTimes(2);
      expect(db.saveAlertHistory).not.toHaveBeenCalled();
    });
  });

  describe('sendBlockTradeAlert', () => {
    it('sends block trade embed to Discord', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };
      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        maxRetries: 0,
      });

      const trade: TradeData = {
        symbol: 'BTC-30AUG24-90000-P',
        timestamp: Date.now(),
        price: 95250.25,
        amount: 1500,
        direction: 'buy',
        tradeId: 'block_trade_123',
        channel: 'block_trade.BTC',
        isBlockTrade: true,
        markPrice: 95260.12,
        indexPrice: 95200.5,
      };

      await manager.sendBlockTradeAlert(trade);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      const [url, payload] = httpClient.post.mock.calls[0];
      expect(url).toContain('wait=true');
      expect(payload).toMatchObject({
        content: expect.stringContaining('ブロックトレード'),
        embeds: expect.arrayContaining([
          expect.objectContaining({
            title: expect.stringContaining('ブロックトレード'),
          }),
        ]),
      });
    });
  });

  describe('checkCPDelta25Alert', () => {
    const createOptionData = (callDelta: number, putDelta: number): OptionData[] => {
      const base: Omit<OptionData, 'delta' | 'symbol'> = {
        timestamp: Date.now(),
        underlyingPrice: 50000,
        markPrice: 1500,
        impliedVolatility: 0.65,
        gamma: 0.001,
        theta: -10,
        vega: 50,
        rho: 5,
      };

      return [
        { ...base, symbol: 'BTC-CALL', delta: callDelta },
        { ...base, symbol: 'BTC-CALL-ALT', delta: callDelta + 0.02 },
        { ...base, symbol: 'BTC-PUT', delta: putDelta },
        { ...base, symbol: 'BTC-PUT-ALT', delta: putDelta - 0.02 },
      ];
    };

    it('emits alert when moving average change exceeds threshold', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        cpPeriod: 2,
        cpChangeThreshold: 0.1,
        cpCooldownMinutes: 15,
      });

      const firstBatch = createOptionData(0.24, -0.24);
      const secondBatch = createOptionData(0.40, -0.20);

      await manager.checkCPDelta25Alert(firstBatch);
      await manager.checkCPDelta25Alert(secondBatch);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      expect(db.saveAlertHistory).toHaveBeenCalledTimes(1);
      expect(db.getRecentAlerts).toHaveBeenCalledWith('CP_DELTA_25', 15);
    });

    it('skips alert when recent alert exists in cooldown window', async () => {
      const db = createMockDatabaseManager();
      const recent: AlertHistory = {
        alertType: 'CP_DELTA_25',
        timestamp: Date.now(),
        value: 0.5,
        threshold: 0.1,
        message: 'dup',
      };
      db.getRecentAlerts.mockResolvedValue([recent]);
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        cpPeriod: 2,
        cpChangeThreshold: 0.1,
        cpCooldownMinutes: 15,
      });

      const firstBatch = createOptionData(0.24, -0.24);
      const secondBatch = createOptionData(0.45, -0.20);

      await manager.checkCPDelta25Alert(firstBatch);
      await manager.checkCPDelta25Alert(secondBatch);

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(db.saveAlertHistory).not.toHaveBeenCalled();
    });
  });

  describe('sendCvdAlertPayload', () => {
    const payload: CvdDeltaAlertPayload = {
      symbol: 'BTC-PERP',
      timestamp: Date.now(),
      bucketSpanMinutes: 5,
      delta: 1500,
      zScore: 3.2,
      threshold: 2.5,
      direction: 'buy',
      windowHours: 72,
    };

    it('sends formatted payload to Discord and records history', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
      });

      await manager.sendCvdAlertPayload(payload);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      expect(db.saveAlertHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: 'CVD_DELTA_5M_BUY',
          threshold: payload.threshold,
        }),
      );
    });

    it('propagates errors from Discord delivery', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockRejectedValue(new Error('discord down')) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        maxRetries: 0,
      });

      await expect(manager.sendCvdAlertPayload(payload)).rejects.toThrow('discord down');
      expect(db.saveAlertHistory).not.toHaveBeenCalled();
    });
  });

  describe('sendMarketTradeStartAlert', () => {
    const shortPayload: MarketTradeStartPayload = {
      symbol: 'BTC-PERP',
      timestamp: Date.now(),
      tradeId: 'trade-123',
      direction: 'buy',
      amount: 1.5,
      strategy: 'SHORT_WINDOW_QUANTILE',
      threshold: 1.2,
      windowMinutes: 30,
      sampleCount: 250,
      quantileLevel: 0.99,
      quantile: 1.2,
    };

    const zScorePayload: MarketTradeStartPayload = {
      symbol: 'BTC-PERP',
      timestamp: Date.now(),
      tradeId: 'trade-456',
      direction: 'sell',
      amount: 2.4,
      strategy: 'LOG_Z_SCORE',
      threshold: 3,
      windowMinutes: 360,
      sampleCount: 800,
      zScore: 3.4,
      zScoreThreshold: 3,
      logMean: 0.1,
      logStdDev: 0.25,
      logAmount: Math.log(2.4),
    };

    it('sends short-window payload to Discord and records history', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
      });

      await manager.sendMarketTradeStartAlert(shortPayload);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      expect(db.saveAlertHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: 'MARKET_TRADE_START_SHORT_WINDOW_BUY',
          threshold: shortPayload.threshold,
          value: shortPayload.amount,
        }),
      );
    });

    it('sends log Z-score payload and stores metric thresholds', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
      });

      await manager.sendMarketTradeStartAlert(zScorePayload);

      expect(httpClient.post).toHaveBeenCalledTimes(1);
      expect(db.saveAlertHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: 'MARKET_TRADE_START_LOG_Z_SELL',
          threshold: zScorePayload.zScoreThreshold,
          value: zScorePayload.zScore,
        }),
      );
    });

    it('propagates errors from Discord delivery', async () => {
      const db = createMockDatabaseManager();
      const httpClient = { post: jest.fn().mockRejectedValue(new Error('discord down')) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        maxRetries: 0,
      });

      await expect(manager.sendMarketTradeStartAlert(shortPayload)).rejects.toThrow('discord down');
      expect(db.saveAlertHistory).not.toHaveBeenCalled();
    });
  });
});
