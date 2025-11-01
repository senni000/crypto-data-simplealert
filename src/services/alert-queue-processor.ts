import { EventEmitter } from 'events';
import { IDatabaseManager } from './interfaces';
import { AlertManager } from './alert-manager';
import {
  AlertQueueRecord,
  CvdDeltaAlertPayload,
  MarketTradeStartPayload,
  CvdSlopeAlertPayload,
} from '../types';
import { logger } from '../utils/logger';

export interface AlertQueueProcessorOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

export declare interface AlertQueueProcessor {
  on(event: 'alertSent', listener: (record: AlertQueueRecord) => void): this;
  on(event: 'alertFailed', listener: (payload: { record: AlertQueueRecord; error: Error }) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export class AlertQueueProcessor extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly databaseManager: IDatabaseManager,
    private readonly alertManager: AlertManager,
    options: AlertQueueProcessorOptions = {}
  ) {
    super();
    this.pollIntervalMs = Math.max(1000, Math.floor(options.pollIntervalMs ?? 5000));
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.processOnce();
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.processing) {
      await this.waitForIdle();
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.processOnce()
        .catch((error) => {
          logger.error('Alert queue processing cycle failed', error);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNext();
          }
        });
    }, this.pollIntervalMs);
  }

  private async processOnce(): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }
    this.processing = true;
    try {
      const records = await this.databaseManager.getPendingAlerts(this.batchSize);
      for (const record of records) {
        if (!this.running) {
          break;
        }

        if (record.attemptCount >= this.maxAttempts) {
          logger.warn('Dropping alert due to max attempts reached', { alertId: record.id });
          await this.databaseManager.markAlertProcessed(record.id);
          continue;
        }

        await this.handleRecord(record);
      }
    } catch (error) {
      logger.error('Failed to process alert queue', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.processing = false;
      this.notifyIdle();
    }
  }

  private async handleRecord(record: AlertQueueRecord): Promise<void> {
    try {
      if (record.alertType.startsWith('CVD_DELTA_')) {
        await this.alertManager.sendCvdAlertPayload(record.payload as CvdDeltaAlertPayload);
      } else if (record.alertType.startsWith('MARKET_TRADE_START')) {
        await this.alertManager.sendMarketTradeStartAlert(record.payload as MarketTradeStartPayload);
      } else if (record.alertType.startsWith('CVD_SLOPE_')) {
        await this.alertManager.sendCvdSlopeAlert(record.payload as CvdSlopeAlertPayload);
      } else {
        logger.warn('Unknown alert type in queue; marking as processed', {
          alertId: record.id,
          alertType: record.alertType,
        });
      }
      await this.databaseManager.markAlertProcessed(record.id);
      this.emit('alertSent', record);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.databaseManager.markAlertFailed(record.id, err);
      this.emit('alertFailed', { record, error: err });
    }
  }

  private waitForIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.processing) {
        resolve();
        return;
      }
      this.waiters.push(resolve);
    });
  }

  private notifyIdle(): void {
    while (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve?.();
    }
  }
}
