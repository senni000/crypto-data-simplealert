/**
 * Crypto Data Alert System
 * Main application entry point
 */

import './utils/setup-logging';
import { initializeConfig, getConfig } from './utils/config';
import { logger } from './utils/logger';
import { DatabaseManager, DataCollector, AlertManager, DataHealthMonitor, DatabaseBackupScheduler } from './services';
import { TradeData, OptionData } from './types';
import { LogLevel } from './types/config';

async function bootstrap(): Promise<void> {
  logger.info('Crypto Data Alert System - Starting up');

  await initializeConfig();
  const config = getConfig();
  setLogLevel(config.logLevel);

  const databaseManager = new DatabaseManager(config.databasePath);
  await databaseManager.initializeDatabase();

  const dataCollector = new DataCollector(databaseManager, {
    websocketUrl: config.deribitApiUrl,
    optionDataInterval: config.optionDataInterval,
  });

  const alertManager = new AlertManager(databaseManager, {
    webhookUrl: config.discordWebhookUrl,
    cvdThreshold: config.cvdZScoreThreshold,
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
        targetPath: config.databaseBackupPath,
        intervalMs: config.databaseBackupInterval,
        retentionDays: config.databaseBackupRetentionDays,
      })
    : null;

  bindDataCollectorEvents(dataCollector, alertManager);
  bindHealthMonitor(dataCollector, healthMonitor);
  bindAlertManagerEvents(alertManager);

  setupGlobalErrorHandlers();
  setupShutdownHooks(dataCollector, databaseManager, healthMonitor, backupScheduler);

  await dataCollector.start();
  healthMonitor.start();
  if (backupScheduler) {
    backupScheduler.start();
  }

  logger.info('Crypto Data Alert System is running');
}

function setLogLevel(level: LogLevel): void {
  logger.setLevel(level);
}

function bindDataCollectorEvents(dataCollector: DataCollector, alertManager: AlertManager): void {
  dataCollector.on('error', (error) => logger.error('DataCollector error event received', error));
  dataCollector.on('websocketError', (error) => logger.error('WebSocket client error', error));
  dataCollector.on('restError', (error) => logger.error('REST client error', error));
  dataCollector.on('tradeDataSaved', (count) => logger.debug(`Stored ${count} trades`));
  dataCollector.on('optionDataSaved', (count) => logger.debug(`Stored ${count} options`));

  dataCollector.on('tradeDataReceived', (trades: TradeData[]) => {
    alertManager.checkCVDAlert(trades).catch((error) => {
      logger.error('Failed to evaluate CVD alert', error);
    });
  });

  dataCollector.on('blockTradeThresholdExceeded', (trades: TradeData[]) => {
    trades.forEach((trade) => {
      alertManager.sendBlockTradeAlert(trade).catch((error) => {
        logger.error(`Failed to send block trade alert (tradeId: ${trade.tradeId})`, error);
      });
    });
  });

  dataCollector.on('optionDataReceived', (options: OptionData[]) => {
    alertManager.checkCPDelta25Alert(options).catch((error) => {
      logger.error('Failed to evaluate C-P Δ25 alert', error);
    });
  });
}

function bindHealthMonitor(dataCollector: DataCollector, healthMonitor: DataHealthMonitor): void {
  dataCollector.on('tradeDataReceived', (trades: TradeData[]) => healthMonitor.trackTradeData(trades));
  dataCollector.on('tradeDataSaved', () => healthMonitor.markTradeBatchPersisted());
  dataCollector.on('optionDataReceived', (options: OptionData[]) => healthMonitor.trackOptionData(options));
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

function bindAlertManagerEvents(alertManager: AlertManager): void {
  alertManager.on('alertSent', (message) => {
    logger.info(`Alert delivered: ${message.type}`, message);
  });

  alertManager.on('alertFailed', (error, message) => {
    logger.error(`Alert delivery failed: ${message.type}`, error);
  });

  alertManager.on('cpDeltaAlert', (message) => {
    logger.debug('C-P Δ25 alert triggered', message);
  });

  alertManager.on('cvdAlert', (message) => {
    logger.debug('CVD alert triggered', message);
  });
}

function setupGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
  });
}

function setupShutdownHooks(
  dataCollector: DataCollector,
  databaseManager: DatabaseManager,
  healthMonitor: DataHealthMonitor,
  backupScheduler: DatabaseBackupScheduler | null
): void {
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

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

    logger.info('Shutdown complete. Exiting process.');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  logger.error('Fatal error during bootstrap', error);
  process.exit(1);
});
