/**
 * Run data collector for a limited duration to verify database writes and alert flow.
 */

import { initializeConfig, getConfig } from '../src/utils/config';
import { logger } from '../src/utils/logger';
import { DatabaseManager, DataCollector, AlertManager } from '../src/services';
import { HttpClient, AlertManagerOptions } from '../src/services/alert-manager';
import { OptionData, TradeData } from '../src/types';

const DEFAULT_DURATION_MS = 60_000;

async function run(): Promise<void> {
  await initializeConfig();
  const config = getConfig();
  logger.setLevel(config.logLevel);

  const durationMs = Number(process.env['COLLECT_DURATION_MS'] ?? DEFAULT_DURATION_MS);
  const enableAlerts = process.env['ENABLE_ALERTS'] === 'true';

  logger.info('Starting sample data collection run', {
    databasePath: config.databasePath,
    durationMs,
    enableAlerts,
  });

  const databaseManager = new DatabaseManager(config.databasePath);
  await databaseManager.initializeDatabase();

  const dataCollector = new DataCollector(databaseManager, {
    websocketUrl: config.deribitApiUrl,
    optionDataInterval: config.optionDataInterval,
  });

  const dryRunClient: HttpClient | undefined = enableAlerts
    ? undefined
    : {
        post: async (url: string, payload?: unknown) => {
          logger.info('[DRY-RUN] Alert payload suppressed', { url, payload });
          return {
            status: 204,
            data: null,
            statusText: 'No Content',
            headers: {},
            config: {},
          } as any;
        },
      };

  const alertOptions: AlertManagerOptions = {
    webhookUrl: config.discordWebhookUrl,
    cvdThreshold: config.cvdZScoreThreshold,
  };

  if (!enableAlerts && dryRunClient) {
    alertOptions.httpClient = dryRunClient;
    alertOptions.maxRetries = 0;
  }

  const alertManager = new AlertManager(databaseManager, alertOptions);

  bindCollectorEvents(dataCollector, alertManager);
  bindAlertEvents(alertManager);

  await dataCollector.start();

  logger.info('Collector started, waiting for duration…');
  await sleep(durationMs);

  logger.info('Stopping collector…');
  await dataCollector.stopCollection();

  logger.info('Gathering database statistics…');
  const trades = await databaseManager.getTradeDataLast24Hours();
  const options = await databaseManager.getLatestOptionData();
  const alerts = await databaseManager.getRecentAlerts('CP_DELTA_25', 60);

  logger.info('Sample run summary', {
    tradesCaptured: trades.length,
    optionSnapshotSize: options.length,
    recentAlerts: alerts.length,
  });

  await databaseManager.closeDatabase();
  logger.info('Sample data collection run completed');
}

function bindCollectorEvents(dataCollector: DataCollector, alertManager: AlertManager): void {
  dataCollector.on('tradeDataReceived', (trades: TradeData[]) => {
    logger.debug(`Received trade batch`, { count: trades.length });
    alertManager
      .checkCVDAlert(trades)
      .catch((error) => logger.error('CVD alert evaluation failed', error));
  });

  dataCollector.on('optionDataReceived', (options: OptionData[]) => {
    logger.debug(`Received option batch`, { count: options.length });
    alertManager
      .checkCPDelta25Alert(options)
      .catch((error) => logger.error('CP Delta alert evaluation failed', error));
  });

  dataCollector.on('websocketConnected', () => logger.info('WebSocket connected'));
  dataCollector.on('websocketDisconnected', (info) => logger.warn('WebSocket disconnected', info));
  dataCollector.on('websocketError', (error) => logger.error('WebSocket error', error));
  dataCollector.on('restError', (error) => logger.error('REST client error', error));
}

function bindAlertEvents(alertManager: AlertManager): void {
  alertManager.on('alertSent', (message) => logger.info('Alert dispatched', message));
  alertManager.on('alertFailed', (error, message) =>
    logger.error(`Alert failed: ${message.type}`, error)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Sample run failed', error);
    process.exit(1);
  });
