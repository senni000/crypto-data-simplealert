import '../utils/setup-logging';
import { initializeConfig, getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import {
  DatabaseManager,
  AlertManager,
  AlertQueueProcessor,
  AnalyticsAlertProcessor,
  SkewChartReporter,
  ProcessingState,
} from '../services';
import { TradeData } from '../types';

interface IntervalWorker {
  stop(): void;
}

async function bootstrap(): Promise<void> {
  await initializeConfig();
  const config = getConfig();

  logger.setLevel(config.logLevel);
  logger.info('Deribit alert dispatcher - starting up');

  const databaseManager = new DatabaseManager(config.databasePath);
  await databaseManager.initializeDatabase();

  const alertManager = new AlertManager(databaseManager, {
    webhookUrl: config.discordWebhookUrl,
    cvdCooldownMinutes: config.cvdAlertSuppressionMinutes,
  });

  const queueProcessor = new AlertQueueProcessor(databaseManager, alertManager, {
    pollIntervalMs: config.alertQueuePollIntervalMs,
    batchSize: config.alertQueueBatchSize,
    maxAttempts: config.alertQueueMaxAttempts,
  });

  const watchers: IntervalWorker[] = [];

  bindQueueProcessorEvents(queueProcessor);

  const analyticsProcessor =
    config.analyticsEnabled && config.enableCvdAlerts
      ? new AnalyticsAlertProcessor(databaseManager, {
          ratioLookbackMs: config.optionDataInterval * 24,
        })
      : null;

  const skewReporter =
    config.analyticsEnabled && config.enableCvdAlerts
      ? new SkewChartReporter(databaseManager, alertManager)
      : null;

  if (analyticsProcessor) {
    watchers.push(createAnalyticsWatcher(analyticsProcessor, config.analyticsAlertIntervalMs));
  }

  watchers.push(
    createOptionWatcher(databaseManager, alertManager, config.alertOptionPollIntervalMs)
  );

  watchers.push(
    await createBlockTradeWatcher(
      databaseManager,
      alertManager,
      config.blockTradePollIntervalMs,
      config.blockTradeAmountThreshold
    )
  );

  setupProcessHandlers({
    queueProcessor,
    databaseManager,
    skewReporter,
    watchers,
  });

  if (skewReporter) {
    skewReporter.start();
  }

  await queueProcessor.start();
  logger.info('Deribit alert dispatcher is running');
}

function bindQueueProcessorEvents(processor: AlertQueueProcessor): void {
  processor.on('alertSent', (record) => {
    logger.info('Dispatched Deribit alert', {
      alertId: record.id,
      alertType: record.alertType,
      symbol: record.payload.symbol,
    });
  });

  processor.on('alertFailed', ({ record, error }) => {
    logger.error('Failed to dispatch Deribit alert', {
      alertId: record.id,
      alertType: record.alertType,
      error: error.message,
      attempts: record.attemptCount + 1,
    });
  });

  processor.on('error', (error) => {
    logger.error('Alert queue processor error', error);
  });
}

function createAnalyticsWatcher(
  processor: AnalyticsAlertProcessor,
  intervalMs: number
): IntervalWorker {
  let running = false;
  const interval = Math.max(5000, intervalMs);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await processor.processLatestAnalytics(Date.now());
    } catch (error) {
      logger.error('Analytics alert processing failed', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);

  void tick();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function createOptionWatcher(
  databaseManager: DatabaseManager,
  alertManager: AlertManager,
  intervalMs: number
): IntervalWorker {
  let lastTimestamp = 0;
  let running = false;
  const interval = Math.max(1000, intervalMs);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const options = await databaseManager.getLatestOptionData();
      if (!options.length) {
        return;
      }
      const latestTimestamp = options.reduce(
        (max, option) => Math.max(max, option.timestamp),
        lastTimestamp
      );
      if (latestTimestamp <= lastTimestamp) {
        return;
      }
      lastTimestamp = latestTimestamp;
      await alertManager.checkCPDelta25Alert(options);
    } catch (error) {
      logger.error('Failed to evaluate CP Delta alerts', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);

  void tick();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

async function createBlockTradeWatcher(
  databaseManager: DatabaseManager,
  alertManager: AlertManager,
  intervalMs: number,
  threshold: number
): Promise<IntervalWorker> {
  let running = false;
  const interval = Math.max(1000, intervalMs);
  const initialState: ProcessingState = {
    lastRowId: 0,
    lastTimestamp: 0,
  };
  let state =
    (await databaseManager.getProcessingState('alert_block_trade', 'trade')) ?? null;

  if (!state || state.lastRowId === 0) {
    const cursor = await databaseManager.getLatestTradeCursor();
    if (cursor) {
      state = {
        lastRowId: cursor.rowId,
        lastTimestamp: cursor.timestamp,
      };
      await databaseManager.saveProcessingState('alert_block_trade', 'trade', state);
      logger.info('Seeded block trade watcher cursor from latest trade', {
        rowId: state.lastRowId,
        timestamp: state.lastTimestamp,
      });
    } else {
      state = initialState;
    }
  }

  let lastRowId = state.lastRowId;
  let lastTimestamp = state.lastTimestamp;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const trades = await databaseManager.getLargeTradeDataSinceRowId(lastRowId, 500, threshold);
      if (trades.length === 0) {
        return;
      }

      for (const trade of trades) {
        const isBlockTrade = trade.isBlockTrade === true || trade.channel?.startsWith('block_trade');
        if (!isBlockTrade) {
          continue;
        }
        const payload: TradeData = {
          symbol: trade.symbol,
          timestamp: trade.timestamp,
          price: trade.price,
          amount: trade.amount,
          direction: trade.direction,
          tradeId: trade.tradeId,
        };

        if (trade.channel) {
          payload.channel = trade.channel;
        }
        if (trade.markPrice !== undefined) {
          payload.markPrice = trade.markPrice;
        }
        if (trade.indexPrice !== undefined) {
          payload.indexPrice = trade.indexPrice;
        }
        if (trade.underlyingPrice !== undefined) {
          payload.underlyingPrice = trade.underlyingPrice;
        }
        payload.isBlockTrade = true;

        await alertManager.sendBlockTradeAlert(payload);
      }

      lastRowId = trades[trades.length - 1]!.rowId;
      lastTimestamp = trades[trades.length - 1]!.timestamp;
      await databaseManager.saveProcessingState('alert_block_trade', 'trade', {
        lastRowId,
        lastTimestamp,
      });
    } catch (error) {
      logger.error('Failed to process block trade alerts', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);

  await tick();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function setupProcessHandlers(params: {
  queueProcessor: AlertQueueProcessor;
  databaseManager: DatabaseManager;
  skewReporter: SkewChartReporter | null;
  watchers: IntervalWorker[];
}): void {
  const { queueProcessor, databaseManager, skewReporter, watchers } = params;

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info(`Received ${signal}, shutting down alert dispatcher...`);

    if (skewReporter) {
      skewReporter.stop();
    }

    for (const watcher of watchers) {
      try {
        watcher.stop();
      } catch (error) {
        logger.error('Failed to stop watcher cleanly', error);
      }
    }

    await queueProcessor.stop().catch((error) => {
      logger.error('Failed to stop alert queue processor gracefully', error);
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
  logger.error('Fatal error during alert dispatcher bootstrap', error);
  process.exit(1);
});
