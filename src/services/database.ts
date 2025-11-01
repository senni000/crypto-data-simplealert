/**
 * Database Manager Implementation
 * Handles SQLite database operations for the Crypto Data Alert System
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import {
  TradeData,
  OptionData,
  CVDData,
  AlertHistory,
  OrderFlowRatioData,
  SkewRawData,
  ExpiryType,
  DeltaBucket,
  OptionType,
  TradeDataRow,
  AlertQueueRecord,
  CvdDeltaAlertPayload,
  MarketTradeStartPayload,
  CvdSlopeAlertPayload,
  QueuedAlertPayload,
} from '../types';
import { IDatabaseManager, ProcessingState } from './interfaces';

export class DatabaseManager implements IDatabaseManager {
  private db: sqlite3.Database | null = null;
  private dbPath: string;

  constructor(databasePath: string) {
    this.dbPath = databasePath;
  }

  /**
   * Initialize database connection and create schema
   */
  async initializeDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Ensure directory exists
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }

        // Create database connection
        this.db = new sqlite3.Database(this.dbPath, (err) => {
          if (err) {
            console.error('Failed to connect to database:', err);
            reject(err);
            return;
          }

          // Create tables and indexes
          this.createTables()
            .then(() => this.ensureAnalyticsColumns())
            .then(() => this.ensureTradeAugmentationColumns())
            .then(() => this.ensureCvdDeltaColumns())
            .then(() => this.createIndexes())
            .then(() => {
              console.log('Database initialized successfully');
              resolve();
            })
            .catch(reject);
        });
      } catch (error) {
        console.error('Failed to initialize database:', error);
        reject(error);
      }
    });
  }

  /**
   * Create database tables
   */
  private async createTables(): Promise<void> {
    const db = this.getDatabase();

    const tables = [
      `CREATE TABLE IF NOT EXISTS trade_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        price REAL NOT NULL,
        amount REAL NOT NULL,
        direction TEXT NOT NULL,
        trade_id TEXT UNIQUE NOT NULL,
        channel TEXT,
        mark_price REAL,
        index_price REAL,
        underlying_price REAL,
        is_block_trade INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS option_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        underlying_price REAL NOT NULL,
        mark_price REAL NOT NULL,
        implied_volatility REAL NOT NULL,
        delta REAL NOT NULL,
        gamma REAL NOT NULL,
        theta REAL NOT NULL,
        vega REAL NOT NULL,
        rho REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS cvd_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        bucket_span_minutes INTEGER NOT NULL DEFAULT 5,
        cvd_value REAL NOT NULL,
        z_score REAL NOT NULL,
        delta_value REAL NOT NULL DEFAULT 0,
        delta_z_score REAL NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, bucket_span_minutes, timestamp)
      )`,
      `CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        threshold REAL NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS order_flow_ratio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        expiry_type TEXT NOT NULL,
        expiry_timestamp INTEGER,
        delta_bucket TEXT NOT NULL,
        option_type TEXT NOT NULL,
        ratio REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS skew_raw_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        expiry_type TEXT NOT NULL,
        expiry_timestamp INTEGER,
        delta_bucket TEXT NOT NULL,
        option_type TEXT NOT NULL,
        mark_iv REAL NOT NULL,
        mark_price REAL NOT NULL,
        delta REAL NOT NULL,
        index_price REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS processing_state (
        process_name TEXT NOT NULL,
        key TEXT NOT NULL,
        last_row_id INTEGER NOT NULL DEFAULT 0,
        last_timestamp INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (process_name, key)
      )`,
      `CREATE TABLE IF NOT EXISTS alert_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        processed_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    return new Promise((resolve, reject) => {
      let completed = 0;
      
      for (const tableSql of tables) {
        db.run(tableSql, (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          completed++;
          if (completed === tables.length) {
            resolve();
          }
        });
      }
    });
  }

  private async ensureCvdDeltaColumns(): Promise<void> {
    const db = this.getDatabase();
    const columns = await new Promise<Array<{ name: string }>>((resolve, reject) => {
      db.all('PRAGMA table_info(cvd_data)', [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows as Array<{ name: string }>);
        }
      });
    });

    const columnNames = new Set(columns.map((row) => row.name));

    if (!columnNames.has('delta_value')) {
      await new Promise<void>((resolve, reject) => {
        db.run('ALTER TABLE cvd_data ADD COLUMN delta_value REAL NOT NULL DEFAULT 0', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    if (!columnNames.has('delta_z_score')) {
      await new Promise<void>((resolve, reject) => {
        db.run('ALTER TABLE cvd_data ADD COLUMN delta_z_score REAL NOT NULL DEFAULT 0', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    if (!columnNames.has('symbol')) {
      await new Promise<void>((resolve, reject) => {
        db.run('ALTER TABLE cvd_data ADD COLUMN symbol TEXT', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    if (!columnNames.has('bucket_span_minutes')) {
      await new Promise<void>((resolve, reject) => {
        db.run('ALTER TABLE cvd_data ADD COLUMN bucket_span_minutes INTEGER NOT NULL DEFAULT 5', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  }

  /**
   * Create database indexes for performance optimization
   */
  private async createIndexes(): Promise<void> {
    const db = this.getDatabase();

    const indexes = [
      'DROP INDEX IF EXISTS idx_cvd_data_symbol_bucket_timestamp',
      'CREATE INDEX IF NOT EXISTS idx_trade_data_timestamp ON trade_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_trade_data_symbol ON trade_data(symbol)',
      'CREATE INDEX IF NOT EXISTS idx_trade_data_block ON trade_data(is_block_trade, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_option_data_timestamp ON option_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_option_data_symbol ON option_data(symbol)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_cvd_data_symbol_bucket_timestamp ON cvd_data(symbol, bucket_span_minutes, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp ON alert_history(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history(alert_type)',
      'CREATE INDEX IF NOT EXISTS idx_order_flow_ratio_timestamp ON order_flow_ratio(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_order_flow_ratio_bucket ON order_flow_ratio(expiry_type, delta_bucket, option_type)',
      'CREATE INDEX IF NOT EXISTS idx_skew_raw_data_timestamp ON skew_raw_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_skew_raw_data_bucket ON skew_raw_data(expiry_type, delta_bucket, option_type)',
      'CREATE INDEX IF NOT EXISTS idx_processing_state_lookup ON processing_state(process_name, key)',
      'CREATE INDEX IF NOT EXISTS idx_alert_queue_pending ON alert_queue(processed_at, id)'
    ];

    return new Promise((resolve, reject) => {
      let completed = 0;
      
      for (const indexSql of indexes) {
        db.run(indexSql, (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          completed++;
          if (completed === indexes.length) {
            resolve();
          }
        });
      }
    });
  }

  /**
   * Get database connection (throws error if not initialized)
   */
  private getDatabase(): sqlite3.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return this.db;
  }

  /**
   * Save trade data to database
   */
  async saveTradeData(data: TradeData[]): Promise<void> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT OR IGNORE INTO trade_data 
      (symbol, timestamp, price, amount, direction, trade_id, channel, mark_price, index_price, underlying_price, is_block_trade)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        let completed = 0;
        let hasError = false;
        
        if (data.length === 0) {
          db.run('COMMIT');
          resolve();
          return;
        }
        
        for (const trade of data) {
          db.run(insertSql, [
            trade.symbol,
            trade.timestamp,
            trade.price,
            trade.amount,
            trade.direction,
            trade.tradeId,
            trade.channel ?? null,
            typeof trade.markPrice === 'number' ? trade.markPrice : null,
            typeof trade.indexPrice === 'number' ? trade.indexPrice : null,
            typeof trade.underlyingPrice === 'number' ? trade.underlyingPrice : null,
            trade.isBlockTrade ? 1 : 0
          ], (err) => {
            if (err && !hasError) {
              hasError = true;
              db.run('ROLLBACK');
              console.error('Failed to save trade data:', err);
              reject(err);
              return;
            }
            
            completed++;
            if (completed === data.length && !hasError) {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('Failed to commit trade data:', commitErr);
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
            }
          });
        }
      });
    });
  }

  /**
   * Save option data to database
   */
  async saveOptionData(data: OptionData[]): Promise<void> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT INTO option_data 
      (symbol, timestamp, underlying_price, mark_price, implied_volatility, 
       delta, gamma, theta, vega, rho)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        let completed = 0;
        let hasError = false;
        
        if (data.length === 0) {
          db.run('COMMIT');
          resolve();
          return;
        }
        
        for (const option of data) {
          db.run(insertSql, [
            option.symbol,
            option.timestamp,
            option.underlyingPrice,
            option.markPrice,
            option.impliedVolatility,
            option.delta,
            option.gamma,
            option.theta,
            option.vega,
            option.rho
          ], (err) => {
            if (err && !hasError) {
              hasError = true;
              db.run('ROLLBACK');
              console.error('Failed to save option data:', err);
              reject(err);
              return;
            }
            
            completed++;
            if (completed === data.length && !hasError) {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('Failed to commit option data:', commitErr);
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
            }
          });
        }
      });
    });
  }

  /**
   * Get trade data from the last 24 hours
   */
  async getTradeDataLast24Hours(): Promise<TradeData[]> {
    const db = this.getDatabase();
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    const selectSql = `
      SELECT symbol, timestamp, price, amount, direction, trade_id as tradeId
      FROM trade_data 
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [twentyFourHoursAgo], (err, rows) => {
        if (err) {
          console.error('Failed to get trade data:', err);
          reject(err);
        } else {
          resolve(rows as TradeData[]);
        }
      });
    });
  }

  /**
   * Get trade data rows since a specific rowId
   */
  async getTradeDataSinceRowId(lastRowId: number, limit: number): Promise<TradeDataRow[]> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT
        rowid as rowId,
        symbol,
        timestamp,
        price,
        amount,
        direction,
        trade_id as tradeId,
        channel,
        mark_price as markPrice,
        index_price as indexPrice,
        underlying_price as underlyingPrice,
        is_block_trade as isBlockTrade
      FROM trade_data
      WHERE rowid > ?
      ORDER BY rowid ASC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [lastRowId, Math.max(1, Math.floor(limit))], (err, rows) => {
        if (err) {
          console.error('Failed to get trade data since rowId:', err);
          reject(err);
        } else {
          const mapped = (rows as Array<Record<string, unknown>>).map((row) => this.mapTradeRow(row));
          resolve(mapped);
        }
      });
    });
  }

  /**
   * Get large trade candidates since a specific rowId
   */
  async getLargeTradeDataSinceRowId(lastRowId: number, limit: number, minAmount: number): Promise<TradeDataRow[]> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT
        rowid as rowId,
        symbol,
        timestamp,
        price,
        amount,
        direction,
        trade_id as tradeId,
        channel,
        mark_price as markPrice,
        index_price as indexPrice,
        underlying_price as underlyingPrice,
        is_block_trade as isBlockTrade
      FROM trade_data
      WHERE rowid > ?
        AND amount >= ?
      ORDER BY rowid ASC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [lastRowId, minAmount, Math.max(1, Math.floor(limit))], (err, rows) => {
        if (err) {
          console.error('Failed to get large trade data:', err);
          reject(err);
        } else {
          const mapped = (rows as Array<Record<string, unknown>>).map((row) => this.mapTradeRow(row));
          resolve(mapped);
        }
      });
    });
  }

  /**
   * Get latest trade cursor (rowId / timestamp)
   */
  async getLatestTradeCursor(symbol?: string): Promise<{ rowId: number; timestamp: number } | null> {
    const db = this.getDatabase();

    const selectSql = symbol
      ? `
        SELECT rowid as rowId, timestamp
        FROM trade_data
        WHERE symbol = ?
        ORDER BY rowid DESC
        LIMIT 1
      `
      : `
        SELECT rowid as rowId, timestamp
        FROM trade_data
        ORDER BY rowid DESC
        LIMIT 1
      `;

    const params = symbol ? [symbol] : [];

    return new Promise((resolve, reject) => {
      db.get(selectSql, params, (err, row: { rowId?: number; timestamp?: number } | undefined) => {
        if (err) {
          console.error('Failed to fetch latest trade cursor:', err);
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          resolve({
            rowId: Number(row.rowId ?? 0),
            timestamp: Number(row.timestamp ?? 0),
          });
        }
      });
    });
  }

  /**
   * Normalize SQLite row into TradeDataRow object
   */
  private mapTradeRow(row: Record<string, unknown>): TradeDataRow {
    const trade: TradeDataRow = {
      rowId: Number(row['rowId'] ?? 0),
      symbol: String(row['symbol'] ?? ''),
      timestamp: Number(row['timestamp'] ?? 0),
      price: Number(row['price'] ?? 0),
      amount: Number(row['amount'] ?? 0),
      direction: (row['direction'] as 'buy' | 'sell') ?? 'buy',
      tradeId: String(row['tradeId'] ?? ''),
    };

    const channel = row['channel'];
    if (channel !== undefined && channel !== null) {
      trade.channel = String(channel);
    }

    const markPrice = row['markPrice'];
    if (markPrice !== undefined && markPrice !== null) {
      trade.markPrice = Number(markPrice);
    }

    const indexPrice = row['indexPrice'];
    if (indexPrice !== undefined && indexPrice !== null) {
      trade.indexPrice = Number(indexPrice);
    }

    const underlyingPrice = row['underlyingPrice'];
    if (underlyingPrice !== undefined && underlyingPrice !== null) {
      trade.underlyingPrice = Number(underlyingPrice);
    }

    const isBlock = Number(row['isBlockTrade'] ?? 0) === 1;
    if (isBlock) {
      trade.isBlockTrade = true;
    }

    return trade;
  }

  /**
   * Get the latest option data
   */
  async getLatestOptionData(): Promise<OptionData[]> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT 
        symbol, 
        timestamp, 
        underlying_price as underlyingPrice,
        mark_price as markPrice,
        implied_volatility as impliedVolatility,
        delta, 
        gamma, 
        theta, 
        vega, 
        rho
      FROM option_data 
      WHERE timestamp = (
        SELECT MAX(timestamp) FROM option_data
      )
      ORDER BY symbol
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, (err, rows) => {
        if (err) {
          console.error('Failed to get latest option data:', err);
          reject(err);
        } else {
          resolve(rows as OptionData[]);
        }
      });
    });
  }

  /**
   * Save CVD calculation results
   */
  async saveCVDData(data: CVDData): Promise<void> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT INTO cvd_data (symbol, timestamp, bucket_span_minutes, cvd_value, z_score, delta_value, delta_z_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, bucket_span_minutes, timestamp)
      DO UPDATE SET
        cvd_value = excluded.cvd_value,
        z_score = excluded.z_score,
        delta_value = excluded.delta_value,
        delta_z_score = excluded.delta_z_score,
        created_at = CURRENT_TIMESTAMP
    `;

    return new Promise((resolve, reject) => {
        db.run(insertSql, [
          data.symbol,
          data.timestamp,
          data.bucketSpanMinutes,
          data.cvdValue ?? data.delta,
          data.zScore ?? data.deltaZScore,
          data.delta,
          data.deltaZScore,
      ], (err) => {
        if (err) {
          console.error('Failed to save CVD data:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get CVD data for Z-score calculation (last 24 hours)
   */
  /**
   * Backwards-compatible helper to retrieve recent 5分バケットのCVDデータ
   */
  async getCVDDataLast24Hours(symbol: string): Promise<CVDData[]> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return this.getCvdDataSince(symbol, 5, since);
  }

  /**
   * Get CVD delta data since a specific timestamp for the given bucket span
   */
  async getCvdDataSince(symbol: string, bucketSpanMinutes: number, since: number): Promise<CVDData[]> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT 
        symbol as symbol,
        timestamp,
        bucket_span_minutes as bucketSpanMinutes,
        cvd_value as cvdValue,
        z_score as zScore,
        delta_value as delta,
        delta_z_score as deltaZScore
      FROM cvd_data
      WHERE symbol = ?
        AND bucket_span_minutes = ?
        AND timestamp >= ?
      ORDER BY timestamp ASC
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [symbol, bucketSpanMinutes, since], (err, rows) => {
        if (err) {
          console.error('Failed to get CVD data since timestamp:', err);
          reject(err);
        } else {
          resolve(rows as CVDData[]);
        }
      });
    });
  }

  /**
   * Save alert history
   */
  async saveAlertHistory(alert: AlertHistory): Promise<void> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT INTO alert_history (alert_type, timestamp, value, threshold, message)
      VALUES (?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.run(insertSql, [
        alert.alertType,
        alert.timestamp,
        alert.value,
        alert.threshold,
        alert.message
      ], (err) => {
        if (err) {
          console.error('Failed to save alert history:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get recent alert history to prevent duplicate alerts
   */
  async getRecentAlerts(alertType: string, minutes: number = 30): Promise<AlertHistory[]> {
    const db = this.getDatabase();
    const timeThreshold = Date.now() - (minutes * 60 * 1000);
    
    const selectSql = `
      SELECT 
        id,
        alert_type as alertType,
        timestamp,
        value,
        threshold,
        message,
        created_at as createdAt
      FROM alert_history 
      WHERE alert_type = ? AND timestamp >= ?
      ORDER BY timestamp DESC
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [alertType, timeThreshold], (err, rows) => {
        if (err) {
          console.error('Failed to get recent alerts:', err);
          reject(err);
        } else {
          resolve(rows as AlertHistory[]);
        }
      });
    });
  }

  /**
   * Retrieve saved processing state for a worker
   */
  async getProcessingState(processName: string, key: string): Promise<ProcessingState | null> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT
        last_row_id as lastRowId,
        last_timestamp as lastTimestamp
      FROM processing_state
      WHERE process_name = ?
        AND key = ?
    `;

    return new Promise((resolve, reject) => {
      db.get(selectSql, [processName, key], (err, row: { lastRowId?: number; lastTimestamp?: number } | undefined) => {
        if (err) {
          console.error('Failed to load processing state:', err);
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          resolve({
            lastRowId: Number(row.lastRowId ?? 0),
            lastTimestamp: Number(row.lastTimestamp ?? 0),
          });
        }
      });
    });
  }

  /**
   * Persist worker processing state
   */
  async saveProcessingState(processName: string, key: string, state: ProcessingState): Promise<void> {
    const db = this.getDatabase();

    const upsertSql = `
      INSERT INTO processing_state (process_name, key, last_row_id, last_timestamp, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(process_name, key)
      DO UPDATE SET
        last_row_id = excluded.last_row_id,
        last_timestamp = excluded.last_timestamp,
        updated_at = CURRENT_TIMESTAMP
    `;

    return new Promise((resolve, reject) => {
      db.run(upsertSql, [processName, key, state.lastRowId, state.lastTimestamp], (err) => {
        if (err) {
          console.error('Failed to save processing state:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Enqueue alert payload for asynchronous dispatch
   */
  async enqueueAlert(alertType: string, payload: QueuedAlertPayload, timestamp: number): Promise<number> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT INTO alert_queue (alert_type, timestamp, payload_json)
      VALUES (?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.run(insertSql, [alertType, timestamp, JSON.stringify(payload)], function (err) {
        if (err) {
          console.error('Failed to enqueue alert payload:', err);
          reject(err);
        } else {
          resolve(Number(this.lastID));
        }
      });
    });
  }

  /**
   * Retrieve pending alerts from queue
   */
  async getPendingAlerts(limit: number): Promise<AlertQueueRecord[]> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT
        id,
        alert_type as alertType,
        timestamp,
        payload_json as payloadJson,
        attempt_count as attemptCount,
        last_error as lastError,
        processed_at as processedAt,
        created_at as createdAt
      FROM alert_queue
      WHERE processed_at IS NULL
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [Math.max(1, Math.floor(limit))], (err, rows) => {
        if (err) {
          console.error('Failed to load pending alerts:', err);
          reject(err);
        } else {
          const mapped: AlertQueueRecord[] = (rows as Array<Record<string, unknown>>).map((row) => {
            const record: AlertQueueRecord = {
              id: Number(row['id']),
              alertType: String(row['alertType'] ?? ''),
              timestamp: Number(row['timestamp'] ?? 0),
              payload: this.parseAlertPayload(String(row['payloadJson'] ?? '{}'), String(row['alertType'] ?? '')),
              attemptCount: Number(row['attemptCount'] ?? 0),
            };

            if (row['lastError'] !== undefined && row['lastError'] !== null) {
              record.lastError = String(row['lastError']);
            }

            if (row['processedAt'] !== undefined && row['processedAt'] !== null) {
              record.processedAt = Number(row['processedAt']);
            }

            if (row['createdAt'] !== undefined && row['createdAt'] !== null) {
              record.createdAt = Number(new Date(String(row['createdAt'])).getTime());
            }

            return record;
          });
          resolve(mapped);
        }
      });
    });
  }

  private parseAlertPayload(payloadJson: string, alertType: string): QueuedAlertPayload {
    try {
      const parsed = JSON.parse(payloadJson);
      if (alertType.startsWith('CVD_DELTA_')) {
        return parsed as CvdDeltaAlertPayload;
      }
      if (alertType.startsWith('MARKET_TRADE_START')) {
        return parsed as MarketTradeStartPayload;
      }
      if (alertType.startsWith('CVD_SLOPE_')) {
        return parsed as CvdSlopeAlertPayload;
      }
      return parsed as QueuedAlertPayload;
    } catch (error) {
      console.error('Failed to parse alert payload JSON', { alertType, error });
      return {} as QueuedAlertPayload;
    }
  }

  /**
   * Mark alert queue record processed successfully
   */
  async markAlertProcessed(id: number): Promise<void> {
    const db = this.getDatabase();

    const updateSql = `
      UPDATE alert_queue
      SET processed_at = ?
      WHERE id = ?
    `;

    return new Promise((resolve, reject) => {
      db.run(updateSql, [Date.now(), id], (err) => {
        if (err) {
          console.error('Failed to mark alert as processed:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Record alert processing failure
   */
  async markAlertFailed(id: number, error: Error): Promise<void> {
    const db = this.getDatabase();

    const updateSql = `
      UPDATE alert_queue
      SET attempt_count = attempt_count + 1,
          last_error = ?,
          processed_at = NULL
      WHERE id = ?
    `;

    return new Promise((resolve, reject) => {
      db.run(updateSql, [error.message, id], (err) => {
        if (err) {
          console.error('Failed to update alert failure state:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Determine if recent alerts or pending items exist for suppression
   */
  async hasRecentAlertOrPending(alertType: string, cutoffTimestamp: number): Promise<boolean> {
    const db = this.getDatabase();

    const alertPromise = new Promise<boolean>((resolve, reject) => {
      db.get(
        `
          SELECT 1
          FROM alert_history
          WHERE alert_type = ?
            AND timestamp >= ?
          LIMIT 1
        `,
        [alertType, cutoffTimestamp],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        }
      );
    });

    const queuePromise = new Promise<boolean>((resolve, reject) => {
      db.get(
        `
          SELECT 1
          FROM alert_queue
          WHERE alert_type = ?
            AND processed_at IS NULL
            AND timestamp >= ?
          LIMIT 1
        `,
        [alertType, cutoffTimestamp],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        }
      );
    });

    try {
      const [hasAlert, hasPending] = await Promise.all([alertPromise, queuePromise]);
      return hasAlert || hasPending;
    } catch (error) {
      console.error('Failed to evaluate alert suppression state:', error);
      return false;
    }
  }

  async pruneOlderThan(cutoffTimestamp: number): Promise<void> {
    const db = this.getDatabase();
    const run = (sql: string, params: unknown[] = []): Promise<void> =>
      new Promise((resolve, reject) => {
        db.run(sql, params, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

    const statements: Array<{ sql: string; params: unknown[] }> = [
      { sql: 'DELETE FROM trade_data WHERE timestamp < ?', params: [cutoffTimestamp] },
      { sql: 'DELETE FROM option_data WHERE timestamp < ?', params: [cutoffTimestamp] },
      { sql: 'DELETE FROM cvd_data WHERE timestamp < ?', params: [cutoffTimestamp] },
      { sql: 'DELETE FROM alert_history WHERE timestamp < ?', params: [cutoffTimestamp] },
      { sql: 'DELETE FROM order_flow_ratio WHERE timestamp < ?', params: [cutoffTimestamp] },
      { sql: 'DELETE FROM skew_raw_data WHERE timestamp < ?', params: [cutoffTimestamp] },
      {
        sql: 'DELETE FROM alert_queue WHERE processed_at IS NOT NULL AND timestamp < ?',
        params: [cutoffTimestamp],
      },
    ];

    for (const { sql, params } of statements) {
      await run(sql, params);
    }
  }

  /**
   * Ensure new analytics columns exist on legacy databases
   */
  private async ensureAnalyticsColumns(): Promise<void> {
    await this.addColumnIfMissing('order_flow_ratio', 'expiry_timestamp', 'INTEGER');
    await this.addColumnIfMissing('skew_raw_data', 'expiry_timestamp', 'INTEGER');
  }

  /**
   * Ensure trade table contains optional metadata columns
   */
  private async ensureTradeAugmentationColumns(): Promise<void> {
    await this.addColumnIfMissing('trade_data', 'channel', 'TEXT');
    await this.addColumnIfMissing('trade_data', 'mark_price', 'REAL');
    await this.addColumnIfMissing('trade_data', 'index_price', 'REAL');
    await this.addColumnIfMissing('trade_data', 'underlying_price', 'REAL');
    await this.addColumnIfMissing('trade_data', 'is_block_trade', 'INTEGER NOT NULL DEFAULT 0');
  }

  /**
   * Helper to add a column if it does not exist
   */
  private async addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
    const db = this.getDatabase();

    const columnExists = await new Promise<boolean>((resolve, reject) => {
      db.all(`PRAGMA table_info(${table})`, (err, rows: Array<{ name: string }>) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows.some((row) => row.name === column));
      });
    }).catch((error) => {
      console.error(`Failed to inspect table schema for ${table}:`, error);
      return true;
    });

    if (columnExists) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (err) => {
        if (err) {
          console.error(`Failed to add column ${column} to ${table}:`, err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Save order flow ratio data
   */
  async saveOrderFlowRatioData(data: OrderFlowRatioData[]): Promise<void> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT INTO order_flow_ratio (timestamp, expiry_type, expiry_timestamp, delta_bucket, option_type, ratio)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (data.length === 0) {
          db.run('COMMIT');
          resolve();
          return;
        }

        let completed = 0;
        let hasError = false;

        for (const item of data) {
          db.run(insertSql, [
            item.timestamp,
            item.expiryType,
            item.expiryTimestamp ?? null,
            item.deltaBucket,
            item.optionType,
            item.ratio,
          ], (err) => {
            if (err && !hasError) {
              hasError = true;
              db.run('ROLLBACK');
              console.error('Failed to save order flow ratio data:', err);
              reject(err);
              return;
            }

            completed++;
            if (completed === data.length && !hasError) {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('Failed to commit order flow ratio data:', commitErr);
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
            }
          });
        }
      });
    });
  }

  /**
   * Save skew raw data
   */
  async saveSkewRawData(data: SkewRawData[]): Promise<void> {
    const db = this.getDatabase();

    const insertSql = `
      INSERT INTO skew_raw_data (
        timestamp,
        expiry_type,
        expiry_timestamp,
        delta_bucket,
        option_type,
        mark_iv,
        mark_price,
        delta,
        index_price
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (data.length === 0) {
          db.run('COMMIT');
          resolve();
          return;
        }

        let completed = 0;
        let hasError = false;

        for (const item of data) {
          db.run(insertSql, [
            item.timestamp,
            item.expiryType,
            item.expiryTimestamp ?? null,
            item.deltaBucket,
            item.optionType,
            item.markIv,
            item.markPrice,
            item.delta,
            item.indexPrice,
          ], (err) => {
            if (err && !hasError) {
              hasError = true;
              db.run('ROLLBACK');
              console.error('Failed to save skew raw data:', err);
              reject(err);
              return;
            }

            completed++;
            if (completed === data.length && !hasError) {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('Failed to commit skew raw data:', commitErr);
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
            }
          });
        }
      });
    });
  }

  /**
   * Retrieve order flow ratio series for analytics calculations
   */
  async getOrderFlowRatioSeries(params: {
    expiryType: ExpiryType;
    deltaBucket: DeltaBucket;
    optionType: OptionType;
    since?: number;
    limit?: number;
  }): Promise<OrderFlowRatioData[]> {
    const db = this.getDatabase();
    const since = params.since ?? (Date.now() - 24 * 60 * 60 * 1000);
    const limit = params.limit ?? 2000;

    const selectSql = `
      SELECT
        timestamp,
        expiry_type as expiryType,
        expiry_timestamp as expiryTimestamp,
        delta_bucket as deltaBucket,
        option_type as optionType,
        ratio
      FROM order_flow_ratio
      WHERE expiry_type = ?
        AND delta_bucket = ?
        AND option_type = ?
        AND timestamp >= ?
      ORDER BY timestamp ASC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      db.all(
        selectSql,
        [params.expiryType, params.deltaBucket, params.optionType, since, limit],
        (err, rows) => {
          if (err) {
            console.error('Failed to fetch order flow ratio series:', err);
            reject(err);
          } else {
            resolve(rows as OrderFlowRatioData[]);
          }
        }
      );
    });
  }

  /**
   * Retrieve skew raw data series for analytics calculations
   */
  async getSkewRawSeries(params: {
    expiryType: ExpiryType;
    deltaBucket: DeltaBucket;
    optionType: OptionType;
    since?: number;
    limit?: number;
  }): Promise<SkewRawData[]> {
    const db = this.getDatabase();
    const since = params.since ?? (Date.now() - 24 * 60 * 60 * 1000);
    const limit = params.limit ?? 2000;

    const selectSql = `
      SELECT
        timestamp,
        expiry_type as expiryType,
        expiry_timestamp as expiryTimestamp,
        delta_bucket as deltaBucket,
        option_type as optionType,
        mark_iv as markIv,
        mark_price as markPrice,
        delta,
        index_price as indexPrice
      FROM skew_raw_data
      WHERE expiry_type = ?
        AND delta_bucket = ?
        AND option_type = ?
        AND timestamp >= ?
      ORDER BY timestamp ASC
      LIMIT ?
    `;

    return new Promise((resolve, reject) => {
      db.all(
        selectSql,
        [params.expiryType, params.deltaBucket, params.optionType, since, limit],
        (err, rows) => {
          if (err) {
            console.error('Failed to fetch skew raw data series:', err);
            reject(err);
          } else {
            resolve(rows as SkewRawData[]);
          }
        }
      );
    });
  }

  /**
   * Close database connection
   */
  async closeDatabase(): Promise<void> {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db!.close((err) => {
          if (err) {
            console.error('Failed to close database:', err);
            reject(err);
          } else {
            this.db = null;
            resolve();
          }
        });
      });
    }
  }
}
