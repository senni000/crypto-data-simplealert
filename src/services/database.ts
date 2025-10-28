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
} from '../types';
import { IDatabaseManager } from './interfaces';

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
        timestamp INTEGER NOT NULL,
        cvd_value REAL NOT NULL,
        z_score REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  /**
   * Create database indexes for performance optimization
   */
  private async createIndexes(): Promise<void> {
    const db = this.getDatabase();

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_trade_data_timestamp ON trade_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_trade_data_symbol ON trade_data(symbol)',
      'CREATE INDEX IF NOT EXISTS idx_option_data_timestamp ON option_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_option_data_symbol ON option_data(symbol)',
      'CREATE INDEX IF NOT EXISTS idx_cvd_data_timestamp ON cvd_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp ON alert_history(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history(alert_type)',
      'CREATE INDEX IF NOT EXISTS idx_order_flow_ratio_timestamp ON order_flow_ratio(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_order_flow_ratio_bucket ON order_flow_ratio(expiry_type, delta_bucket, option_type)',
      'CREATE INDEX IF NOT EXISTS idx_skew_raw_data_timestamp ON skew_raw_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_skew_raw_data_bucket ON skew_raw_data(expiry_type, delta_bucket, option_type)'
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
      (symbol, timestamp, price, amount, direction, trade_id)
      VALUES (?, ?, ?, ?, ?, ?)
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
            trade.tradeId
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
      INSERT INTO cvd_data (timestamp, cvd_value, z_score)
      VALUES (?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.run(insertSql, [
        data.timestamp,
        data.cvdValue,
        data.zScore
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
  async getCVDDataLast24Hours(): Promise<CVDData[]> {
    const db = this.getDatabase();
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    const selectSql = `
      SELECT 
        timestamp, 
        cvd_value as cvdValue, 
        z_score as zScore
      FROM cvd_data 
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [twentyFourHoursAgo], (err, rows) => {
        if (err) {
          console.error('Failed to get CVD data:', err);
          reject(err);
        } else {
          resolve(rows as CVDData[]);
        }
      });
    });
  }

  /**
   * Get CVD data from a specific timestamp
   */
  async getCVDDataSince(since: number): Promise<CVDData[]> {
    const db = this.getDatabase();

    const selectSql = `
      SELECT 
        timestamp,
        cvd_value as cvdValue,
        z_score as zScore
      FROM cvd_data
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `;

    return new Promise((resolve, reject) => {
      db.all(selectSql, [since], (err, rows) => {
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
   * Ensure new analytics columns exist on legacy databases
   */
  private async ensureAnalyticsColumns(): Promise<void> {
    await this.addColumnIfMissing('order_flow_ratio', 'expiry_timestamp', 'INTEGER');
    await this.addColumnIfMissing('skew_raw_data', 'expiry_timestamp', 'INTEGER');
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
