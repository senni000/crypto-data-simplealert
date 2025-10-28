/**
 * Database inspection script
 * Validates that core tables contain data and prints simple summaries.
 */

import sqlite3 from 'sqlite3';
import { initializeConfig, getConfig } from '../src/utils/config';
import { logger } from '../src/utils/logger';

type Row = Record<string, unknown>;

function querySingle(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<Row | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as Row | undefined);
    });
  });
}

function queryAll(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows as Row[]);
    });
  });
}

async function run(): Promise<void> {
  await initializeConfig();
  const config = getConfig();
  logger.setLevel(config.logLevel);

  logger.info('Opening database', { databasePath: config.databasePath });

  const db = new sqlite3.Database(config.databasePath);

  try {
    const tradeStats = await querySingle(
      db,
      `
        SELECT
          COUNT(*) AS count,
          MIN(datetime(timestamp/1000, 'unixepoch')) AS oldest,
          MAX(datetime(timestamp/1000, 'unixepoch')) AS newest
        FROM trade_data
      `
    );

    const optionStats = await querySingle(
      db,
      `
        SELECT
          COUNT(*) AS count,
          MIN(datetime(timestamp/1000, 'unixepoch')) AS oldest,
          MAX(datetime(timestamp/1000, 'unixepoch')) AS newest
        FROM option_data
      `
    );

    const alertStats = await querySingle(
      db,
      `
        SELECT
          COUNT(*) AS count,
          MIN(datetime(timestamp/1000, 'unixepoch')) AS oldest,
          MAX(datetime(timestamp/1000, 'unixepoch')) AS newest
        FROM alert_history
      `
    );

    logger.info('Table counts', {
      trade_data: tradeStats,
      option_data: optionStats,
      alert_history: alertStats,
    });

    const latestTrades = await queryAll(
      db,
      `
        SELECT
          symbol,
          price,
          amount,
          direction,
          datetime(timestamp/1000, 'unixepoch') AS ts
        FROM trade_data
        ORDER BY timestamp DESC
        LIMIT 5
      `
    );

    const latestOptions = await queryAll(
      db,
      `
        SELECT
          symbol,
          mark_price AS markPrice,
          implied_volatility AS iv,
          delta,
          datetime(timestamp/1000, 'unixepoch') AS ts
        FROM option_data
        ORDER BY timestamp DESC, symbol
        LIMIT 5
      `
    );

    const recentAlerts = await queryAll(
      db,
      `
        SELECT
          alert_type AS alertType,
          value,
          threshold,
          message,
          datetime(timestamp/1000, 'unixepoch') AS ts
        FROM alert_history
        ORDER BY timestamp DESC
        LIMIT 5
      `
    );

    logger.info('Latest trades snapshot', latestTrades);
    logger.info('Latest options snapshot', latestOptions);
    logger.info('Recent alerts snapshot', recentAlerts);
  } catch (error) {
    logger.error('Database inspection failed', error);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

run().catch((error) => {
  logger.error('Unexpected error during database inspection', error);
  process.exit(1);
});
