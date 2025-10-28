/**
 * Unit tests for DatabaseManager
 * Tests data save/retrieve functionality and data integrity verification
 */

import { DatabaseManager } from '../database';
import { TradeData, OptionData, CVDData, AlertHistory } from '../../types';
import fs from 'fs';
import path from 'path';

describe('DatabaseManager', () => {
  let dbManager: DatabaseManager;
  let testDbPath: string;

  beforeEach(async () => {
    // Create a temporary database for testing
    testDbPath = path.join(__dirname, 'test_crypto_data.db');
    dbManager = new DatabaseManager(testDbPath);
    await dbManager.initializeDatabase();
  });

  afterEach(async () => {
    // Clean up test database
    await dbManager.closeDatabase();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Database Initialization', () => {
    it('should initialize database successfully', async () => {
      const newDbPath = path.join(__dirname, 'test_init.db');
      const newDbManager = new DatabaseManager(newDbPath);
      
      await expect(newDbManager.initializeDatabase()).resolves.not.toThrow();
      
      // Verify database file was created
      expect(fs.existsSync(newDbPath)).toBe(true);
      
      await newDbManager.closeDatabase();
      fs.unlinkSync(newDbPath);
    });

    it('should create directory if it does not exist', async () => {
      const testDir = path.join(__dirname, 'test_dir');
      const newDbPath = path.join(testDir, 'test.db');
      const newDbManager = new DatabaseManager(newDbPath);
      
      await newDbManager.initializeDatabase();
      
      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(newDbPath)).toBe(true);
      
      await newDbManager.closeDatabase();
      fs.rmSync(testDir, { recursive: true });
    });
  });

  describe('Trade Data Operations', () => {
    const sampleTradeData: TradeData[] = [
      {
        symbol: 'BTC-PERPETUAL',
        timestamp: Date.now(),
        price: 45000.5,
        amount: 0.1,
        direction: 'buy',
        tradeId: 'trade_001'
      },
      {
        symbol: 'BTC-PERPETUAL',
        timestamp: Date.now() + 1000,
        price: 45001.0,
        amount: 0.2,
        direction: 'sell',
        tradeId: 'trade_002'
      }
    ];

    it('should save trade data successfully', async () => {
      await expect(dbManager.saveTradeData(sampleTradeData)).resolves.not.toThrow();
    });

    it('should handle empty trade data array', async () => {
      await expect(dbManager.saveTradeData([])).resolves.not.toThrow();
    });

    it('should prevent duplicate trade IDs', async () => {
      // Save initial data
      await dbManager.saveTradeData(sampleTradeData);
      
      // Try to save duplicate trade ID - should not throw but should ignore duplicate
      const duplicateData: TradeData[] = [{
        symbol: sampleTradeData[0]!.symbol,
        timestamp: sampleTradeData[0]!.timestamp,
        price: 50000, // Different price but same trade ID
        amount: sampleTradeData[0]!.amount,
        direction: sampleTradeData[0]!.direction,
        tradeId: sampleTradeData[0]!.tradeId
      }];
      
      await expect(dbManager.saveTradeData(duplicateData)).resolves.not.toThrow();
      
      // Verify original data is preserved
      const retrieved = await dbManager.getTradeDataLast24Hours();
      const originalTrade = retrieved.find(t => t.tradeId === sampleTradeData[0]!.tradeId);
      expect(originalTrade).toBeDefined();
      expect(originalTrade!.price).toBe(sampleTradeData[0]!.price);
    });

    it('should retrieve trade data from last 24 hours', async () => {
      const now = Date.now();
      const oldTradeData: TradeData[] = [{
        symbol: 'BTC-PERPETUAL',
        timestamp: now - (25 * 60 * 60 * 1000), // 25 hours ago
        price: 44000,
        amount: 0.1,
        direction: 'buy',
        tradeId: 'old_trade'
      }];
      
      const recentTradeData: TradeData[] = [{
        symbol: 'BTC-PERPETUAL',
        timestamp: now - (1 * 60 * 60 * 1000), // 1 hour ago
        price: 45000,
        amount: 0.1,
        direction: 'buy',
        tradeId: 'recent_trade'
      }];
      
      await dbManager.saveTradeData([...oldTradeData, ...recentTradeData]);
      
      const retrieved = await dbManager.getTradeDataLast24Hours();
      
      // Should only return recent trade data
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!.tradeId).toBe('recent_trade');
    });

    it('should maintain data integrity for trade data', async () => {
      await dbManager.saveTradeData(sampleTradeData);
      const retrieved = await dbManager.getTradeDataLast24Hours();
      
      expect(retrieved).toHaveLength(2);
      
      // Verify data integrity
      const trade1 = retrieved.find(t => t.tradeId === 'trade_001');
      const trade2 = retrieved.find(t => t.tradeId === 'trade_002');
      
      expect(trade1).toMatchObject({
        symbol: 'BTC-PERPETUAL',
        price: 45000.5,
        amount: 0.1,
        direction: 'buy',
        tradeId: 'trade_001'
      });
      
      expect(trade2).toMatchObject({
        symbol: 'BTC-PERPETUAL',
        price: 45001.0,
        amount: 0.2,
        direction: 'sell',
        tradeId: 'trade_002'
      });
    });
  });

  describe('Option Data Operations', () => {
    const sampleOptionData: OptionData[] = [
      {
        symbol: 'BTC-29DEC23-45000-C',
        timestamp: Date.now(),
        underlyingPrice: 45000,
        markPrice: 1500,
        impliedVolatility: 0.65,
        delta: 0.5,
        gamma: 0.001,
        theta: -10,
        vega: 50,
        rho: 5
      },
      {
        symbol: 'BTC-29DEC23-45000-P',
        timestamp: Date.now(),
        underlyingPrice: 45000,
        markPrice: 1200,
        impliedVolatility: 0.68,
        delta: -0.5,
        gamma: 0.001,
        theta: -8,
        vega: 48,
        rho: -5
      }
    ];

    it('should save option data successfully', async () => {
      await expect(dbManager.saveOptionData(sampleOptionData)).resolves.not.toThrow();
    });

    it('should handle empty option data array', async () => {
      await expect(dbManager.saveOptionData([])).resolves.not.toThrow();
    });

    it('should retrieve latest option data', async () => {
      const now = Date.now();
      
      // Save older data
      const olderData: OptionData[] = [{
        symbol: sampleOptionData[0]!.symbol,
        timestamp: now - 3600000, // 1 hour ago
        underlyingPrice: sampleOptionData[0]!.underlyingPrice,
        markPrice: sampleOptionData[0]!.markPrice,
        impliedVolatility: sampleOptionData[0]!.impliedVolatility,
        delta: sampleOptionData[0]!.delta,
        gamma: sampleOptionData[0]!.gamma,
        theta: sampleOptionData[0]!.theta,
        vega: sampleOptionData[0]!.vega,
        rho: sampleOptionData[0]!.rho
      }];
      
      // Save newer data
      const newerData: OptionData[] = [{
        symbol: sampleOptionData[1]!.symbol,
        timestamp: now,
        underlyingPrice: sampleOptionData[1]!.underlyingPrice,
        markPrice: sampleOptionData[1]!.markPrice,
        impliedVolatility: sampleOptionData[1]!.impliedVolatility,
        delta: sampleOptionData[1]!.delta,
        gamma: sampleOptionData[1]!.gamma,
        theta: sampleOptionData[1]!.theta,
        vega: sampleOptionData[1]!.vega,
        rho: sampleOptionData[1]!.rho
      }];
      
      await dbManager.saveOptionData(olderData);
      await dbManager.saveOptionData(newerData);
      
      const latest = await dbManager.getLatestOptionData();
      
      // Should only return the latest timestamp data
      expect(latest).toHaveLength(1);
      expect(latest[0]!.symbol).toBe(sampleOptionData[1]!.symbol);
      expect(latest[0]!.timestamp).toBe(now);
    });

    it('should maintain data integrity for option data', async () => {
      await dbManager.saveOptionData(sampleOptionData);
      const retrieved = await dbManager.getLatestOptionData();
      
      expect(retrieved).toHaveLength(2);
      
      // Verify data integrity
      const callOption = retrieved.find(o => o.symbol.includes('-C'));
      const putOption = retrieved.find(o => o.symbol.includes('-P'));
      
      expect(callOption).toMatchObject({
        symbol: 'BTC-29DEC23-45000-C',
        underlyingPrice: 45000,
        markPrice: 1500,
        impliedVolatility: 0.65,
        delta: 0.5,
        gamma: 0.001,
        theta: -10,
        vega: 50,
        rho: 5
      });
      
      expect(putOption).toMatchObject({
        symbol: 'BTC-29DEC23-45000-P',
        underlyingPrice: 45000,
        markPrice: 1200,
        impliedVolatility: 0.68,
        delta: -0.5,
        gamma: 0.001,
        theta: -8,
        vega: 48,
        rho: -5
      });
    });
  });

  describe('CVD Data Operations', () => {
    const sampleCVDData: CVDData = {
      timestamp: Date.now(),
      cvdValue: 1500.75,
      zScore: 2.5
    };

    it('should save CVD data successfully', async () => {
      await expect(dbManager.saveCVDData(sampleCVDData)).resolves.not.toThrow();
    });

    it('should retrieve CVD data from last 24 hours', async () => {
      const now = Date.now();
      
      // Save old CVD data (25 hours ago)
      const oldCVDData: CVDData = {
        timestamp: now - (25 * 60 * 60 * 1000),
        cvdValue: 1000,
        zScore: 1.0
      };
      
      // Save recent CVD data (1 hour ago)
      const recentCVDData: CVDData = {
        timestamp: now - (1 * 60 * 60 * 1000),
        cvdValue: 1500,
        zScore: 2.0
      };
      
      await dbManager.saveCVDData(oldCVDData);
      await dbManager.saveCVDData(recentCVDData);
      
      const retrieved = await dbManager.getCVDDataLast24Hours();
      
      // Should only return recent CVD data
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!.cvdValue).toBe(1500);
      expect(retrieved[0]!.zScore).toBe(2.0);
    });

    it('should maintain data integrity for CVD data', async () => {
      await dbManager.saveCVDData(sampleCVDData);
      const retrieved = await dbManager.getCVDDataLast24Hours();
      
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!).toMatchObject({
        cvdValue: 1500.75,
        zScore: 2.5
      });
      expect(retrieved[0]!.timestamp).toBe(sampleCVDData.timestamp);
    });
  });

  describe('Alert History Operations', () => {
    const sampleAlertHistory: AlertHistory = {
      alertType: 'CVD_ZSCORE',
      timestamp: Date.now(),
      value: 2.5,
      threshold: 2.0,
      message: 'CVD Z-score exceeded threshold'
    };

    it('should save alert history successfully', async () => {
      await expect(dbManager.saveAlertHistory(sampleAlertHistory)).resolves.not.toThrow();
    });

    it('should retrieve recent alerts within time window', async () => {
      const now = Date.now();
      
      // Save old alert (45 minutes ago)
      const oldAlert: AlertHistory = {
        ...sampleAlertHistory,
        timestamp: now - (45 * 60 * 1000)
      };
      
      // Save recent alert (15 minutes ago)
      const recentAlert: AlertHistory = {
        ...sampleAlertHistory,
        timestamp: now - (15 * 60 * 1000)
      };
      
      await dbManager.saveAlertHistory(oldAlert);
      await dbManager.saveAlertHistory(recentAlert);
      
      // Get alerts from last 30 minutes
      const recentAlerts = await dbManager.getRecentAlerts('CVD_ZSCORE', 30);
      
      // Should only return the recent alert
      expect(recentAlerts).toHaveLength(1);
      expect(recentAlerts[0]!.timestamp).toBe(recentAlert.timestamp);
    });

    it('should maintain data integrity for alert history', async () => {
      await dbManager.saveAlertHistory(sampleAlertHistory);
      const retrieved = await dbManager.getRecentAlerts('CVD_ZSCORE', 60);
      
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!).toMatchObject({
        alertType: 'CVD_ZSCORE',
        value: 2.5,
        threshold: 2.0,
        message: 'CVD Z-score exceeded threshold'
      });
      expect(retrieved[0]!.timestamp).toBe(sampleAlertHistory.timestamp);
    });

    it('should filter alerts by type correctly', async () => {
      const cvdAlert: AlertHistory = {
        alertType: 'CVD_ZSCORE',
        timestamp: Date.now(),
        value: 2.5,
        threshold: 2.0,
        message: 'CVD alert'
      };
      
      const cpAlert: AlertHistory = {
        alertType: 'CP_DELTA_25',
        timestamp: Date.now(),
        value: 0.15,
        threshold: 0.1,
        message: 'CP Delta alert'
      };
      
      await dbManager.saveAlertHistory(cvdAlert);
      await dbManager.saveAlertHistory(cpAlert);
      
      const cvdAlerts = await dbManager.getRecentAlerts('CVD_ZSCORE', 60);
      const cpAlerts = await dbManager.getRecentAlerts('CP_DELTA_25', 60);
      
      expect(cvdAlerts).toHaveLength(1);
      expect(cpAlerts).toHaveLength(1);
      expect(cvdAlerts[0]!.alertType).toBe('CVD_ZSCORE');
      expect(cpAlerts[0]!.alertType).toBe('CP_DELTA_25');
    });
  });

  describe('Error Handling', () => {
    it('should throw error when database is not initialized', async () => {
      const uninitializedDb = new DatabaseManager('/tmp/test.db');
      
      await expect(uninitializedDb.saveTradeData([])).rejects.toThrow('Database not initialized');
      await expect(uninitializedDb.getTradeDataLast24Hours()).rejects.toThrow('Database not initialized');
    });

    it('should handle transaction rollback on error', async () => {
      // This test verifies that invalid data doesn't corrupt the database
      const validData: TradeData[] = [{
        symbol: 'BTC-PERPETUAL',
        timestamp: Date.now(),
        price: 45000,
        amount: 0.1,
        direction: 'buy',
        tradeId: 'valid_trade'
      }];
      
      // Save valid data first
      await dbManager.saveTradeData(validData);
      
      // Verify valid data was saved
      const beforeError = await dbManager.getTradeDataLast24Hours();
      expect(beforeError).toHaveLength(1);
      
      // Try to save invalid data (this should fail due to duplicate trade_id)
      const invalidData: TradeData[] = [{
        symbol: validData[0]!.symbol,
        timestamp: validData[0]!.timestamp,
        price: validData[0]!.price,
        amount: validData[0]!.amount,
        direction: validData[0]!.direction,
        tradeId: validData[0]!.tradeId // Same trade ID should be ignored, not cause error
      }];
      
      // This should not throw but should ignore duplicate
      await expect(dbManager.saveTradeData(invalidData)).resolves.not.toThrow();
      
      // Verify database state is still consistent
      const afterError = await dbManager.getTradeDataLast24Hours();
      expect(afterError).toHaveLength(1);
    });
  });
});