import '../utils/setup-logging';
import { initializeConfig, getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { DatabaseManager, CvdAggregationWorker } from '../services';

async function bootstrap(): Promise<void> {
  await initializeConfig();
  const config = getConfig();

  logger.setLevel(config.logLevel);
  logger.info('Deribit CVD aggregation worker - starting up');

  const databaseManager = new DatabaseManager(config.databasePath);
  await databaseManager.initializeDatabase();

  const worker = new CvdAggregationWorker(
    databaseManager,
    {
      symbol: config.cvdAggregationSymbol,
      threshold: config.cvdZScoreThreshold,
      alertsEnabled: config.enableCvdAlerts,
      tradeSymbols: config.cvdAggregationTradeSymbols,
    },
    {
      batchSize: config.cvdAggregationBatchSize,
      pollIntervalMs: config.cvdAggregationPollIntervalMs,
      suppressionWindowMinutes: config.cvdAlertSuppressionMinutes,
      historyWindowHours: Math.max(72, Math.ceil(config.marketTradeZScoreWindowMinutes / 60)),
      marketTradeShortWindowMinutes: config.marketTradeShortWindowMinutes,
      marketTradeShortQuantile: config.marketTradeShortQuantile,
      marketTradeShortMinSamples: config.marketTradeShortMinSamples,
      marketTradeZScoreWindowMinutes: config.marketTradeZScoreWindowMinutes,
      marketTradeZScoreThreshold: config.marketTradeZScoreThreshold,
      marketTradeZScoreMinSamples: config.marketTradeZScoreMinSamples,
      marketTradeLinkMinutes: config.marketTradeLinkMinutes,
      cvdSlopeThreshold: config.cvdSlopeThreshold,
      cvdSlopeEmaAlpha: config.cvdSlopeEmaAlpha,
      cvdSlopeWindowHours: config.cvdSlopeWindowHours,
    }
  );

  bindWorkerEvents(worker);
  setupProcessHandlers(worker, databaseManager);

  await worker.start();
  logger.info('Deribit CVD aggregation worker is running');
}

function bindWorkerEvents(worker: CvdAggregationWorker): void {
  worker.on('batchProcessed', ({ count }) => {
    logger.debug(`Processed ${count} Deribit trades for CVD aggregation`);
  });

  worker.on('idle', () => {
    logger.debug('CVD aggregation worker idle');
  });

  worker.on('error', (error) => {
    logger.error('CVD aggregation worker error', error);
  });
}

function setupProcessHandlers(worker: CvdAggregationWorker, databaseManager: DatabaseManager): void {
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info(`Received ${signal}, shutting down CVD aggregation worker...`);
    await worker.stop().catch((error) => {
      logger.error('Failed to stop CVD aggregation worker gracefully', error);
    });
    await databaseManager.closeDatabase().catch((error) => {
      logger.error('Failed to close database during shutdown', error);
    });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    process.exit(1);
  });
}

void bootstrap().catch((error) => {
  logger.error('Fatal error during aggregation bootstrap', error);
  process.exit(1);
});
