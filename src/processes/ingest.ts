import '../utils/setup-logging';
import { initializeConfig, getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import {
  DatabaseManager,
  DataCollector,
  DataHealthMonitor,
  DatabaseBackupScheduler,
} from '../services';

async function bootstrap(): Promise<void> {
  await initializeConfig();
  const config = getConfig();

  logger.setLevel(config.logLevel);
  logger.info('Deribit ingestion process - starting up');

  const databaseManager = new DatabaseManager(config.databasePath);
  await databaseManager.initializeDatabase();

  const dataCollector = new DataCollector(databaseManager, {
    websocketUrl: config.deribitApiUrl,
    optionDataInterval: config.optionDataInterval,
    enableAnalyticsCollection: config.analyticsEnabled,
    analyticsIntervalMs: config.analyticsIntervalMs,
    analyticsInstrumentRefreshIntervalMs: config.analyticsInstrumentRefreshIntervalMs,
    analyticsRatioPriceWindowUsd: config.analyticsRatioWindowUsd,
  });

  const healthMonitor = new DataHealthMonitor({
    optionIntervalMs: config.optionDataInterval,
    optionGapToleranceMs: 5 * 60 * 1000,
    tradeStaleThresholdMs: 5 * 60 * 1000,
    checkIntervalMs: 60 * 1000,
    sleepThresholdMs: 2 * 60 * 1000,
    restErrorThreshold: 5,
    restErrorWindowMs: 10 * 60 * 1000,
  });

  const backupScheduler = config.databaseBackupEnabled
    ? new DatabaseBackupScheduler({
        sourcePath: config.databasePath,
        targetDirectory: config.databaseBackupDirectory,
        intervalMs: config.databaseBackupIntervalMs,
        fileName: 'deribit_backup.sqlite',
        databaseManager,
        ...(config.databaseRetentionMs != null ? { retentionMs: config.databaseRetentionMs } : {}),
      })
    : null;

  bindDataCollectorEvents(dataCollector);
  bindHealthMonitor(dataCollector, healthMonitor);

  setupProcessHandlers({
    dataCollector,
    databaseManager,
    healthMonitor,
    backupScheduler,
  });

  await dataCollector.start();
  healthMonitor.start();
  if (backupScheduler) {
    backupScheduler.start();
  }

  logger.info('Deribit ingestion process is running');
}

function bindDataCollectorEvents(dataCollector: DataCollector): void {
  dataCollector.on('error', (error) => logger.error('DataCollector error event received', error));
  dataCollector.on('websocketError', (error) => logger.error('WebSocket client error', error));
  dataCollector.on('restError', (error) => logger.error('REST client error', error));
  dataCollector.on('tradeDataSaved', (count) => logger.debug(`Stored ${count} trades`));
  dataCollector.on('optionDataSaved', (count) => logger.debug(`Stored ${count} options`));
  dataCollector.on('ratioDataSaved', (count) => logger.debug(`Stored ${count} order flow ratio rows`));
  dataCollector.on('skewDataSaved', (count) => logger.debug(`Stored ${count} skew raw rows`));
  dataCollector.on('analyticsError', (error) => logger.error('Analytics collector error', error));
  dataCollector.on('analyticsCollectionCompleted', (payload) => {
    logger.debug('Analytics collection completed', payload);
  });
  dataCollector.on('analyticsInstrumentsUpdated', (selection) =>
    logger.debug('Analytics instrument selection updated', selection)
  );
}

function bindHealthMonitor(dataCollector: DataCollector, healthMonitor: DataHealthMonitor): void {
  dataCollector.on('tradeDataReceived', (trades) => healthMonitor.trackTradeData(trades));
  dataCollector.on('tradeDataSaved', () => healthMonitor.markTradeBatchPersisted());
  dataCollector.on('optionDataReceived', (options) => healthMonitor.trackOptionData(options));
  dataCollector.on('optionDataSaved', () => healthMonitor.markOptionBatchPersisted());
  dataCollector.on('restError', (error) => healthMonitor.trackRestError(error));
  dataCollector.on('websocketDisconnected', () => healthMonitor.markWebsocketDisconnected());

  healthMonitor.on('systemResumeDetected', (payload) => {
    logger.warn('Detected potential system sleep or suspension', payload);
    dataCollector.recoverFromSystemResume().catch((error) => {
      logger.error('Failed to recover after system resume detection', error);
    });
  });

  healthMonitor.on('tradeDataStale', (payload) => {
    logger.warn('Trade data stream appears stale', payload);
    dataCollector.restartTradeDataCollection('trade data stale detected').catch((error) => {
      logger.error('Failed to restart trade data collection after stale detection', error);
    });
  });

  healthMonitor.on('optionDataDelayed', (payload) => {
    logger.warn('Option data collection delay detected', payload);
    dataCollector.restartOptionDataCollection('option data delay detected').catch((error) => {
      logger.error('Failed to restart option data collection after delay detection', error);
    });
  });

  healthMonitor.on('optionGapDetected', (payload) => {
    logger.warn('Detected larger than expected gap between option batches', payload);
  });

  healthMonitor.on('restErrorSpike', (payload) => {
    logger.warn('Detected spike in REST API errors', payload);
    dataCollector.restartOptionDataCollection('REST error spike detected').catch((error) => {
      logger.error('Failed to restart option data collection after REST error spike', error);
    });
  });
}

function setupProcessHandlers(params: {
  dataCollector: DataCollector;
  databaseManager: DatabaseManager;
  healthMonitor: DataHealthMonitor;
  backupScheduler: DatabaseBackupScheduler | null;
}): void {
  const { dataCollector, databaseManager, healthMonitor, backupScheduler } = params;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info(`Shutdown initiated by signal: ${signal}`);

    healthMonitor.stop();
    if (backupScheduler) {
      backupScheduler.stop();
    }

    try {
      await dataCollector.stopCollection();
    } catch (error) {
      logger.error('Error while stopping data collector', error);
    }

    try {
      await databaseManager.closeDatabase();
    } catch (error) {
      logger.error('Error while closing database', error);
    }

    logger.info('Ingestion shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    process.exit(1);
  });
}

void bootstrap().catch((error) => {
  logger.error('Fatal error during ingestion bootstrap', error);
  process.exit(1);
});
