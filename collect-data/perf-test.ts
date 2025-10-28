/**
 * Simple performance harness for database write throughput
 */

import { performance } from 'perf_hooks';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { initializeConfig, getConfig } from '../src/utils/config';
import { logger } from '../src/utils/logger';
import { DatabaseManager } from '../src/services/database';
import { TradeData, OptionData } from '../src/types';

const DEFAULT_TRADE_BATCH = 5000;
const DEFAULT_OPTION_BATCH = 2000;

async function run(): Promise<void> {
  await initializeConfig();
  const config = getConfig();
  logger.setLevel(config.logLevel);

  const dbPath =
    process.env.PERF_DATABASE_PATH ||
    path.join(os.tmpdir(), 'crypto-data-alert', 'perf-database.sqlite');

  const tradeBatch = Number(process.env.PERF_TRADE_BATCH ?? DEFAULT_TRADE_BATCH);
  const optionBatch = Number(process.env.PERF_OPTION_BATCH ?? DEFAULT_OPTION_BATCH);

  logger.info('Starting performance harness', {
    dbPath,
    tradeBatch,
    optionBatch,
  });

  const databaseManager = new DatabaseManager(dbPath);
  await databaseManager.initializeDatabase();

  const trades = generateTrades(tradeBatch);
  const options = generateOptions(optionBatch);

  const tradeStart = performance.now();
  await databaseManager.saveTradeData(trades);
  const tradeDuration = performance.now() - tradeStart;

  const optionStart = performance.now();
  await databaseManager.saveOptionData(options);
  const optionDuration = performance.now() - optionStart;

  logger.info('Performance summary', {
    tradesPersisted: tradeBatch,
    tradeDurationMs: tradeDuration.toFixed(2),
    optionsPersisted: optionBatch,
    optionDurationMs: optionDuration.toFixed(2),
  });

  await databaseManager.closeDatabase();

  if (process.env.PERF_KEEP_DB !== 'true') {
    try {
      fs.unlinkSync(dbPath);
    } catch (error) {
      logger.warn('Unable to remove performance database file', error);
    }
  }
}

function generateTrades(count: number): TradeData[] {
  const now = Date.now();

  return Array.from({ length: count }).map((_, index) => ({
    symbol: 'BTC-PERPETUAL',
    timestamp: now - index * 1000,
    price: 40000 + Math.random() * 2000,
    amount: Math.random() * 5 + 0.01,
    direction: Math.random() > 0.5 ? 'buy' : 'sell',
    tradeId: `perf-trade-${index}-${Math.random().toString(36).slice(2, 8)}`,
  }));
}

function generateOptions(count: number): OptionData[] {
  const now = Date.now();

  return Array.from({ length: count }).map((_, index) => ({
    symbol: `BTC-${45000 + index}-C`,
    timestamp: now - index * 60000,
    underlyingPrice: 40000 + Math.random() * 2000,
    markPrice: Math.random() * 1000,
    impliedVolatility: Math.random(),
    delta: Math.random() * 2 - 1,
    gamma: Math.random() * 0.1,
    theta: Math.random() * -0.1,
    vega: Math.random() * 10,
    rho: Math.random() * 0.1,
  }));
}

run()
  .then(() => {
    logger.info('Performance harness completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Performance harness failed', error);
    process.exit(1);
  });
