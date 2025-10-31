import { EventEmitter } from 'events';
import { CumulativeCvdAggregator, CumulativeCvdAggregatorOptions, TradeLike, CvdAlertPayload } from '@crypto-data/cvd-core';
import { IDatabaseManager, ProcessingState } from './interfaces';
import { TradeDataRow } from '../types';
import { logger } from '../utils/logger';

export interface CvdAggregationWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  suppressionWindowMinutes?: number;
}

export declare interface CvdAggregationWorker {
  on(event: 'batchProcessed', listener: (payload: { count: number }) => void): this;
  on(event: 'idle', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

const PROCESS_NAME = 'deribit_cvd_aggregator';

export class CvdAggregationWorker extends EventEmitter {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly suppressionWindowMs: number;
  private readonly threshold: number;
  private readonly alertsEnabled: boolean;
  private readonly symbol: string;
  private readonly tradeSymbols: Set<string>;
  private running = false;
  private processing = false;
  private timer: NodeJS.Timeout | null = null;
  private aggregator: CumulativeCvdAggregator | null = null;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly databaseManager: IDatabaseManager,
    params: {
      symbol: string;
      threshold: number;
      alertsEnabled: boolean;
      tradeSymbols?: string[];
    },
    options: CvdAggregationWorkerOptions = {}
  ) {
    super();
    this.symbol = params.symbol;
    this.threshold = params.threshold;
    this.alertsEnabled = params.alertsEnabled;
    this.tradeSymbols = new Set(
      (params.tradeSymbols ?? []).map((value) => value.toUpperCase())
    );
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
    this.pollIntervalMs = Math.max(500, Math.floor(options.pollIntervalMs ?? 2000));
    this.suppressionWindowMs = Math.max(0, Math.floor((options.suppressionWindowMinutes ?? 30) * 60 * 1000));
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.ensureAggregator();
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

    if (this.aggregator) {
      try {
        await this.aggregator.flush();
      } catch (error) {
        logger.error('Failed to flush CVD aggregator during shutdown', error);
      }
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.processOnce()
        .catch((error) => {
          logger.error('CVD aggregation cycle failed', error);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNext();
          }
        });
    }, this.pollIntervalMs);
  }

  private async ensureAggregator(): Promise<void> {
    if (this.aggregator) {
      return;
    }

    const aggregatorOptions: CumulativeCvdAggregatorOptions = {
      symbol: this.symbol,
      threshold: this.threshold,
      tradeFilter: (trade) => this.isTradeSymbolAllowed(trade.symbol),
    };

    if (this.alertsEnabled) {
      aggregatorOptions.suppressionHandler = {
        shouldSuppress: async () => {
          const cutoff = Date.now() - this.suppressionWindowMs;
          return this.databaseManager.hasRecentAlertOrPending('CVD_ZSCORE', cutoff);
        },
      };
    }

    const aggregator = new CumulativeCvdAggregator(
      {
        repository: {
          loadHistory: (since) => this.databaseManager.getCVDDataSince(this.symbol, since),
          saveRecord: (record) =>
            this.databaseManager.saveCVDData({
              symbol: this.symbol,
              timestamp: record.timestamp,
              cvdValue: record.cvdValue,
              zScore: record.zScore,
              delta: record.delta ?? 0,
              deltaZScore: record.deltaZScore ?? 0,
            }),
        },
        alertHandler: {
          sendAlert: (payload) => this.handleAlert(payload),
        },
        logger,
      },
      aggregatorOptions
    );

    await aggregator.initialize();
    this.aggregator = aggregator;
  }

  private async processOnce(): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }
    this.processing = true;

    try {
      const state = await this.databaseManager.getProcessingState(PROCESS_NAME, this.symbol);

      if (!state || state.lastRowId === 0) {
        const cursor = await this.databaseManager.getLatestTradeCursor();
        if (cursor) {
          const seed: ProcessingState = {
            lastRowId: cursor.rowId,
            lastTimestamp: cursor.timestamp,
          };
          await this.databaseManager.saveProcessingState(PROCESS_NAME, this.symbol, seed);
          logger.info('Seeded CVD aggregation cursor from latest trade', {
            symbol: this.symbol,
            rowId: seed.lastRowId,
            timestamp: seed.lastTimestamp,
          });
        }
        this.emit('idle');
        return;
      }

      let lastRowId = state.lastRowId;
      let lastTimestamp = state.lastTimestamp;
      let hasMore = true;

      while (this.running && hasMore) {
        const rows = await this.databaseManager.getTradeDataSinceRowId(lastRowId, this.batchSize);
        if (rows.length === 0) {
          hasMore = false;
          break;
        }

        const trades = this.filterAndStripTrades(rows);
        if (trades.length > 0) {
          await this.enqueueTrades(trades);
          this.emit('batchProcessed', { count: trades.length });
        }

        lastRowId = rows[rows.length - 1]!.rowId;
        lastTimestamp = rows[rows.length - 1]!.timestamp;
        await this.databaseManager.saveProcessingState(PROCESS_NAME, this.symbol, {
          lastRowId,
          lastTimestamp,
        });

        if (rows.length < this.batchSize) {
          hasMore = false;
        }
      }

      this.emit('idle');
    } catch (error) {
      logger.error('CVD aggregation loop failed', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.processing = false;
      this.notifyIdle();
    }
  }

  private filterAndStripTrades(rows: TradeDataRow[]): TradeLike[] {
    return rows
      .filter((row) => !row.isBlockTrade)
      .filter((row) => this.isTradeSymbolAllowed(row.symbol))
      .map((row) => ({
        symbol: row.symbol,
        timestamp: row.timestamp,
        price: row.price,
        amount: row.amount,
        direction: row.direction,
        tradeId: row.tradeId,
      }));
  }

  private async enqueueTrades(trades: TradeLike[]): Promise<void> {
    if (!this.aggregator || trades.length === 0) {
      return;
    }
    this.aggregator.enqueueTrades(trades);
    await this.aggregator.flush();
  }

  private async handleAlert(payload: CvdAlertPayload): Promise<void> {
    if (!this.alertsEnabled) {
      return;
    }
    try {
      await this.databaseManager.enqueueAlert('CVD_ZSCORE', payload, payload.timestamp);
    } catch (error) {
      logger.error('Failed to enqueue CVD alert payload', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private isTradeSymbolAllowed(rawSymbol: string | undefined): boolean {
    const symbol = (rawSymbol ?? '').toUpperCase();
    if (!symbol) {
      return false;
    }

    if (this.tradeSymbols.size > 0) {
      return this.tradeSymbols.has(symbol);
    }

    if (!symbol.includes('BTC')) {
      return false;
    }
    return symbol.includes('PERP');
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
