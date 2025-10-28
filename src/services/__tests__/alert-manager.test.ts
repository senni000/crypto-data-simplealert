import { AlertManager } from '../alert-manager';
import { IDatabaseManager } from '../interfaces';
import { OptionData, TradeData, AlertMessage, CVDData, AlertHistory } from '../../types';

type MockedDatabaseManager = jest.Mocked<IDatabaseManager>;

const createMockDatabaseManager = (): MockedDatabaseManager => ({
  initializeDatabase: jest.fn().mockResolvedValue(undefined),
  saveTradeData: jest.fn().mockResolvedValue(undefined),
  saveOptionData: jest.fn().mockResolvedValue(undefined),
  getTradeDataLast24Hours: jest.fn().mockResolvedValue([]),
  getLatestOptionData: jest.fn().mockResolvedValue([]),
  saveCVDData: jest.fn().mockResolvedValue(undefined),
  getCVDDataLast24Hours: jest.fn().mockResolvedValue([] as CVDData[]),
  getCVDDataSince: jest.fn().mockResolvedValue([] as CVDData[]),
  saveAlertHistory: jest.fn().mockResolvedValue(undefined),
  getRecentAlerts: jest.fn().mockResolvedValue([]),
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
      expect(httpClient.post).toHaveBeenCalledWith(
        expect.stringContaining(webhookUrl),
        expect.objectContaining({
          content: expect.stringContaining('CP_DELTA_25'),
        }),
      );
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
        type: 'CVD_ZSCORE',
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

  describe('checkCVDAlert', () => {
    const createTrade = (amount: number, direction: 'buy' | 'sell', id: string): TradeData => ({
      symbol: 'BTC-PERPETUAL',
      timestamp: Date.now(),
      price: 45000,
      amount,
      direction,
      tradeId: id,
    });

    it('sends alert when z-score exceeds threshold', async () => {
      const db = createMockDatabaseManager();
      db.getCVDDataLast24Hours.mockResolvedValue([
        { timestamp: 1, cvdValue: 10, zScore: 0 },
        { timestamp: 2, cvdValue: 12, zScore: 0 },
        { timestamp: 3, cvdValue: 14, zScore: 0 },
        { timestamp: 4, cvdValue: 16, zScore: 0 },
      ]);

      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
        cvdThreshold: 2,
        cvdCooldownMinutes: 30,
      });

      const trades = [
        createTrade(6, 'buy', 't1'),
        createTrade(3, 'buy', 't2'),
      ];

      await manager.checkCVDAlert(trades);

      expect(db.saveCVDData).toHaveBeenCalledWith(
        expect.objectContaining({
          cvdValue: expect.any(Number),
          zScore: expect.any(Number),
        }),
      );
      expect(httpClient.post).toHaveBeenCalledTimes(1);
      expect(db.saveAlertHistory).toHaveBeenCalledTimes(1);
      expect(db.getRecentAlerts).toHaveBeenCalledWith('CVD_ZSCORE', 30);
    });

    it('does not send alert when z-score is below threshold', async () => {
      const db = createMockDatabaseManager();
      db.getCVDDataLast24Hours.mockResolvedValue([
        { timestamp: 1, cvdValue: 10, zScore: 0 },
        { timestamp: 2, cvdValue: 11, zScore: 0 },
        { timestamp: 3, cvdValue: 10.5, zScore: 0 },
      ]);

      const httpClient = { post: jest.fn().mockResolvedValue({ status: 204 }) };

      const manager = new AlertManager(db, {
        webhookUrl,
        httpClient,
      });

      const trades = [
        createTrade(0.1, 'buy', 't1'),
        createTrade(0.05, 'sell', 't2'),
      ];

      await manager.checkCVDAlert(trades);

      expect(httpClient.post).not.toHaveBeenCalled();
      expect(db.saveAlertHistory).not.toHaveBeenCalled();
    });
  });
});
