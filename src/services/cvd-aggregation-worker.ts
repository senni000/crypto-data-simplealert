import { EventEmitter } from 'events';
import { ZScoreCalculator } from '@crypto-data/cvd-core';
import { IDatabaseManager, ProcessingState } from './interfaces';
import {
  TradeDataRow,
  CvdDeltaAlertPayload,
  MarketTradeStartPayload,
  MarketTradeStartStrategy,
  CvdSlopeAlertPayload,
} from '../types';
import { logger } from '../utils/logger';

export interface CvdAggregationWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  suppressionWindowMinutes?: number;
  bucketSpansMinutes?: number[];
  historyWindowHours?: number;
  marketTradeShortWindowMinutes?: number;
  marketTradeShortQuantile?: number;
  marketTradeShortMinSamples?: number;
  marketTradeZScoreWindowMinutes?: number;
  marketTradeZScoreThreshold?: number;
  marketTradeZScoreMinSamples?: number;
  marketTradeLinkMinutes?: number;
  cvdSlopeThreshold?: number;
  cvdSlopeEmaAlpha?: number;
  cvdSlopeWindowHours?: number;
}

export declare interface CvdAggregationWorker {
  on(event: 'batchProcessed', listener: (payload: { count: number }) => void): this;
  on(event: 'idle', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface BucketConfig {
  spanMinutes: number;
  windowMs: number;
}

interface BucketState {
  config: BucketConfig;
  history: Array<{ timestamp: number; delta: number }>;
  activeTimestamp: number | null;
  activeDelta: number;
}

interface SlopeUpdateResult {
  slope: number;
  normalized: number | null;
}

const PROCESS_NAME = 'deribit_cvd_aggregator';

const DEFAULT_HISTORY_WINDOW_HOURS = 72;
const DEFAULT_SHORT_WINDOW_MINUTES = 30;
const DEFAULT_SHORT_QUANTILE = 0.99;
const DEFAULT_SHORT_MIN_SAMPLES = 200;
const DEFAULT_ZSCORE_WINDOW_MINUTES = 360;
const DEFAULT_ZSCORE_THRESHOLD = 3;
const DEFAULT_ZSCORE_MIN_SAMPLES = 200;
const DEFAULT_LINK_MINUTES = 10;
const DEFAULT_SLOPE_THRESHOLD = 1.5;
const DEFAULT_SLOPE_ALPHA = 0.3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function computeStd(values: number[], mean?: number): number {
  if (values.length === 0) {
    return 0;
  }
  const m = mean ?? values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance =
    values.reduce((acc, value) => {
      const diff = value - m;
      return acc + diff * diff;
    }, 0) / values.length;
  return Math.sqrt(variance);
}

class ShortWindowQuantileTracker {
  private readonly quantile: number;
  private readonly entries: Array<{ timestamp: number; amount: number } | null> = [];
  private readonly sorted: number[] = [];
  private head = 0;

  constructor(private readonly windowMs: number, quantile: number) {
    this.quantile = clamp(quantile, 0, 1);
  }

  prune(currentTimestamp: number): void {
    const cutoff = currentTimestamp - this.windowMs;
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head];
      if (!entry || entry.timestamp >= cutoff) {
        break;
      }
      this.removeAmount(entry.amount);
      this.entries[this.head] = null;
      this.head += 1;
    }
    if (this.head > 4096 && this.head > this.entries.length / 2) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }

  addSample(timestamp: number, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.entries.push({ timestamp, amount });
    const index = this.lowerBound(amount);
    this.sorted.splice(index, 0, amount);
  }

  getSampleCount(): number {
    return this.sorted.length;
  }

  getQuantile(): number | null {
    if (this.sorted.length === 0) {
      return null;
    }
    if (this.sorted.length === 1) {
      return this.sorted[0]!;
    }
    const targetIndex = Math.min(
      this.sorted.length - 1,
      Math.max(0, Math.floor(this.quantile * (this.sorted.length - 1)))
    );
    return this.sorted[targetIndex]!;
  }

  getWindowMinutes(): number {
    return this.windowMs / (60 * 1000);
  }

  private lowerBound(value: number): number {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.sorted[mid]! < value) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private removeAmount(value: number): void {
    const index = this.findExistingIndex(value);
    if (index !== -1) {
      this.sorted.splice(index, 1);
    }
  }

  private findExistingIndex(value: number): number {
    let low = 0;
    let high = this.sorted.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const current = this.sorted[mid]!;
      if (current === value) {
        let left = mid;
        while (left > 0 && this.sorted[left - 1] === value) {
          left -= 1;
        }
        return left;
      }
      if (current < value) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return -1;
  }
}

class LogZScoreTracker {
  private readonly entries: Array<{ timestamp: number; logAmount: number } | null> = [];
  private head = 0;
  private sum = 0;
  private sumSquares = 0;
  private count = 0;

  constructor(private readonly windowMs: number) {}

  prune(currentTimestamp: number): void {
    const cutoff = currentTimestamp - this.windowMs;
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head];
      if (!entry || entry.timestamp >= cutoff) {
        break;
      }
      this.sum -= entry.logAmount;
      this.sumSquares -= entry.logAmount * entry.logAmount;
      this.count = Math.max(0, this.count - 1);
      this.entries[this.head] = null;
      this.head += 1;
    }
    if (this.head > 4096 && this.head > this.entries.length / 2) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }

  addSample(timestamp: number, amount: number): void {
    const logAmount = this.toLog(amount);
    if (logAmount === null) {
      return;
    }
    this.entries.push({ timestamp, logAmount });
    this.sum += logAmount;
    this.sumSquares += logAmount * logAmount;
    this.count += 1;
  }

  getSampleCount(): number {
    return this.count;
  }

  getWindowMinutes(): number {
    return this.windowMs / (60 * 1000);
  }

  getZScore(amount: number):
    | { zScore: number; mean: number; std: number; logAmount: number; sampleCount: number }
    | null {
    const logAmount = this.toLog(amount);
    if (logAmount === null || this.count < 2) {
      return null;
    }
    const mean = this.sum / this.count;
    const varianceNumerator = this.sumSquares - (this.sum * this.sum) / this.count;
    const variance =
      this.count > 1 ? varianceNumerator / (this.count - 1) : Number.POSITIVE_INFINITY;
    const std = Math.sqrt(Math.max(variance, 1e-12));
    if (!Number.isFinite(std) || std <= 0) {
      return null;
    }
    const zScore = (logAmount - mean) / std;
    return { zScore, mean, std, logAmount, sampleCount: this.count };
  }

  private toLog(amount: number): number | null {
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    return Math.log(amount);
  }
}

class SlopeTracker {
  private ema: number | null = null;
  private prevEma: number | null = null;
  private readonly entries: Array<{ timestamp: number; slope: number }> = [];
  private head = 0;

  constructor(private readonly windowMs: number, private readonly alpha: number) {}

  update(timestamp: number, delta: number, spanMinutes: number, seed = false): SlopeUpdateResult {
    if (this.ema === null) {
      this.ema = delta;
      this.prevEma = delta;
    } else {
      this.ema = this.alpha * delta + (1 - this.alpha) * this.ema;
    }

    const slope =
      this.prevEma === null || spanMinutes <= 0 ? 0 : (this.ema - this.prevEma) / spanMinutes;
    this.prevEma = this.ema;

    this.entries.push({ timestamp, slope });
    this.prune(timestamp);

    if (seed) {
      return { slope, normalized: null };
    }

    const values = this.entries.slice(this.head).map((entry) => entry.slope);
    if (values.length < 12) {
      return { slope, normalized: null };
    }

    const median = computeMedian(values);
    const deviations = values.map((value) => Math.abs(value - median));
    const mad = computeMedian(deviations);

    if (mad > 1e-9) {
      return { slope, normalized: (slope - median) / (mad * 1.4826) };
    }

    const std = computeStd(values, median);
    if (std > 1e-9) {
      return { slope, normalized: (slope - median) / std };
    }

    return { slope, normalized: null };
  }

  private prune(currentTimestamp: number): void {
    const cutoff = currentTimestamp - this.windowMs;
    while (this.head < this.entries.length && this.entries[this.head]!.timestamp < cutoff) {
      this.head += 1;
    }
    if (this.head > 512 && this.head > this.entries.length / 2) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }
}

export class CvdAggregationWorker extends EventEmitter {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly suppressionWindowMs: number;
  private readonly threshold: number;
  private readonly alertsEnabled: boolean;
  private readonly symbol: string;
  private readonly tradeSymbols: Set<string>;
  private readonly bucketConfigs: BucketConfig[];

  private readonly marketTradeShortWindowMs: number;
  private readonly marketTradeShortQuantile: number;
  private readonly marketTradeShortMinSamples: number;
  private readonly marketTradeZScoreWindowMs: number;
  private readonly marketTradeZScoreThreshold: number;
  private readonly marketTradeZScoreMinSamples: number;
  private readonly marketTradeLinkWindowMs: number;
  private readonly cvdSlopeThreshold: number;
  private readonly cvdSlopeAlpha: number;
  private readonly cvdSlopeWindowMs: number;

  private readonly bucketStates = new Map<number, BucketState>();
  private readonly shortWindowTrackers: Record<'buy' | 'sell', ShortWindowQuantileTracker>;
  private readonly logZScoreTrackers: Record<'buy' | 'sell', LogZScoreTracker>;
  private readonly slopeStates = new Map<number, SlopeTracker>();
  private readonly lastTradeStartTimestamp: Record<'buy' | 'sell', number | null> = {
    buy: null,
    sell: null,
  };

  private running = false;
  private processing = false;
  private timer: NodeJS.Timeout | null = null;
  private waiters: Array<() => void> = [];
  private initialized = false;

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
    this.tradeSymbols = new Set((params.tradeSymbols ?? []).map((value) => value.toUpperCase()));
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
    this.pollIntervalMs = Math.max(500, Math.floor(options.pollIntervalMs ?? 2000));
    this.suppressionWindowMs = Math.max(0, Math.floor((options.suppressionWindowMinutes ?? 30) * 60 * 1000));

    const historyWindowHours = Math.max(1, Math.floor(options.historyWindowHours ?? DEFAULT_HISTORY_WINDOW_HOURS));
    const historyWindowMs = historyWindowHours * 60 * 60 * 1000;
    const spans = options.bucketSpansMinutes && options.bucketSpansMinutes.length > 0 ? options.bucketSpansMinutes : [5, 30];
    this.bucketConfigs = spans.map((spanMinutes) => ({ spanMinutes, windowMs: historyWindowMs }));

    this.marketTradeShortWindowMs = Math.max(
      1,
      Math.floor((options.marketTradeShortWindowMinutes ?? DEFAULT_SHORT_WINDOW_MINUTES) * 60 * 1000)
    );
    this.marketTradeShortQuantile = clamp(
      options.marketTradeShortQuantile ?? DEFAULT_SHORT_QUANTILE,
      0.5,
      0.9999
    );
    this.marketTradeShortMinSamples = Math.max(
      10,
      Math.floor(options.marketTradeShortMinSamples ?? DEFAULT_SHORT_MIN_SAMPLES)
    );
    this.marketTradeZScoreWindowMs = Math.max(
      1,
      Math.floor((options.marketTradeZScoreWindowMinutes ?? DEFAULT_ZSCORE_WINDOW_MINUTES) * 60 * 1000)
    );
    this.marketTradeZScoreThreshold = options.marketTradeZScoreThreshold ?? DEFAULT_ZSCORE_THRESHOLD;
    this.marketTradeZScoreMinSamples = Math.max(
      10,
      Math.floor(options.marketTradeZScoreMinSamples ?? DEFAULT_ZSCORE_MIN_SAMPLES)
    );
    this.marketTradeLinkWindowMs = Math.max(
      0,
      Math.floor((options.marketTradeLinkMinutes ?? DEFAULT_LINK_MINUTES) * 60 * 1000)
    );
    this.cvdSlopeThreshold = options.cvdSlopeThreshold ?? DEFAULT_SLOPE_THRESHOLD;
    this.cvdSlopeAlpha = clamp(options.cvdSlopeEmaAlpha ?? DEFAULT_SLOPE_ALPHA, 0.01, 0.99);
    this.cvdSlopeWindowMs = Math.max(
      1,
      Math.floor((options.cvdSlopeWindowHours ?? historyWindowHours) * 60 * 60 * 1000)
    );

    this.shortWindowTrackers = {
      buy: new ShortWindowQuantileTracker(this.marketTradeShortWindowMs, this.marketTradeShortQuantile),
      sell: new ShortWindowQuantileTracker(this.marketTradeShortWindowMs, this.marketTradeShortQuantile),
    };
    this.logZScoreTrackers = {
      buy: new LogZScoreTracker(this.marketTradeZScoreWindowMs),
      sell: new LogZScoreTracker(this.marketTradeZScoreWindowMs),
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.ensureInitialized();
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

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const now = Date.now();
    for (const config of this.bucketConfigs) {
      const since = now - config.windowMs;
      const rows = await this.databaseManager.getCvdDataSince(this.symbol, config.spanMinutes, since);
      const history = rows
        .map((row) => ({ timestamp: row.timestamp, delta: row.delta }))
        .sort((a, b) => a.timestamp - b.timestamp);
      const lastEntry = history.length > 0 ? history[history.length - 1]! : null;
      this.bucketStates.set(config.spanMinutes, {
        config,
        history,
        activeTimestamp: lastEntry ? lastEntry.timestamp : null,
        activeDelta: lastEntry ? lastEntry.delta : 0,
      });

      const slopeTracker = this.getSlopeTracker(config.spanMinutes);
      for (const entry of history) {
        slopeTracker.update(entry.timestamp, entry.delta, config.spanMinutes, true);
      }
    }

    this.initialized = true;
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

  private async processOnce(): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }
    this.processing = true;

    try {
      const state = await this.databaseManager.getProcessingState(PROCESS_NAME, this.symbol);

      if (!state || state.lastRowId === 0) {
        const cursor = await this.databaseManager.getLatestTradeCursor(this.symbol);
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
      let processedTrades = 0;
      let hasMore = true;

      while (this.running && hasMore) {
        const rows = await this.databaseManager.getTradeDataSinceRowId(lastRowId, this.batchSize);
        if (rows.length === 0) {
          hasMore = false;
          break;
        }

        const trades = this.filterTrades(rows);
        for (const trade of trades) {
          await this.detectMarketTradeStart(trade);
        }
        if (trades.length > 0) {
          await this.processTrades(trades);
          processedTrades += trades.length;
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

      if (processedTrades > 0) {
        this.emit('batchProcessed', { count: processedTrades });
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

  private async processTrades(trades: TradeDataRow[]): Promise<void> {
    for (const trade of trades) {
      for (const state of this.bucketStates.values()) {
        await this.applyTradeToBucket(state, trade);
      }
    }
  }

  private async applyTradeToBucket(state: BucketState, trade: TradeDataRow): Promise<void> {
    const bucketTimestamp = this.getBucketTimestamp(trade.timestamp, state.config.spanMinutes);
    const tradeDelta = this.getTradeDelta(trade);

    if (state.activeTimestamp === null) {
      state.activeTimestamp = bucketTimestamp;
      state.activeDelta = this.getExistingDelta(state, bucketTimestamp) + tradeDelta;
      return;
    }

    if (bucketTimestamp === state.activeTimestamp) {
      state.activeDelta += tradeDelta;
      return;
    }

    if (bucketTimestamp > state.activeTimestamp) {
      await this.finalizeActiveBucket(state);
      state.activeTimestamp = bucketTimestamp;
      state.activeDelta = this.getExistingDelta(state, bucketTimestamp) + tradeDelta;
      return;
    }

    await this.applyOutOfOrderTrade(state, bucketTimestamp, tradeDelta);
  }

  private async applyOutOfOrderTrade(
    state: BucketState,
    bucketTimestamp: number,
    tradeDelta: number
  ): Promise<void> {
    const entry = state.history.find((item) => item.timestamp === bucketTimestamp);
    if (!entry) {
      logger.warn('Encountered late trade without existing bucket record', {
        symbol: this.symbol,
        bucketSpanMinutes: state.config.spanMinutes,
        bucketTimestamp,
      });
      return;
    }

    entry.delta += tradeDelta;
    const comparisonValues = this.getComparisonValues(state, bucketTimestamp);
    const zScore = ZScoreCalculator.calculate(entry.delta, comparisonValues);

    await this.databaseManager.saveCVDData({
      symbol: this.symbol,
      timestamp: bucketTimestamp,
      bucketSpanMinutes: state.config.spanMinutes,
      cvdValue: entry.delta,
      zScore,
      delta: entry.delta,
      deltaZScore: zScore,
    });

    this.upsertHistoryEntry(state, bucketTimestamp, entry.delta);
    await this.evaluateCvdDeltaAlert(state, bucketTimestamp, entry.delta, zScore);

    const slopeResult = this.getSlopeTracker(state.config.spanMinutes).update(
      bucketTimestamp,
      entry.delta,
      state.config.spanMinutes
    );
    await this.evaluateCvdSlopeAlert(state.config.spanMinutes, bucketTimestamp, entry.delta, slopeResult);
  }

  private async finalizeActiveBucket(state: BucketState): Promise<void> {
    if (state.activeTimestamp === null) {
      return;
    }

    const bucketTimestamp = state.activeTimestamp;
    const delta = state.activeDelta;
    const comparisonValues = this.getComparisonValues(state, bucketTimestamp);
    const zScore = ZScoreCalculator.calculate(delta, comparisonValues);

    await this.databaseManager.saveCVDData({
      symbol: this.symbol,
      timestamp: bucketTimestamp,
      bucketSpanMinutes: state.config.spanMinutes,
      cvdValue: delta,
      zScore,
      delta,
      deltaZScore: zScore,
    });

    this.upsertHistoryEntry(state, bucketTimestamp, delta);
    await this.evaluateCvdDeltaAlert(state, bucketTimestamp, delta, zScore);

    const slopeResult = this.getSlopeTracker(state.config.spanMinutes).update(
      bucketTimestamp,
      delta,
      state.config.spanMinutes
    );
    await this.evaluateCvdSlopeAlert(state.config.spanMinutes, bucketTimestamp, delta, slopeResult);

    state.activeTimestamp = null;
    state.activeDelta = 0;
  }

  private async detectMarketTradeStart(trade: TradeDataRow): Promise<void> {
    if (!this.alertsEnabled) {
      return;
    }
    if (trade.isBlockTrade || trade.amount <= 0) {
      return;
    }

    const direction: 'buy' | 'sell' = trade.direction === 'buy' ? 'buy' : 'sell';
    const cutoff = Date.now() - this.suppressionWindowMs;

    const shortTracker = this.shortWindowTrackers[direction];
    const zScoreTracker = this.logZScoreTrackers[direction];

    shortTracker.prune(trade.timestamp);
    zScoreTracker.prune(trade.timestamp);

    const shortSampleCount = shortTracker.getSampleCount();
    const shortThreshold = shortTracker.getQuantile();
    const shouldTriggerShort =
      shortSampleCount >= this.marketTradeShortMinSamples &&
      shortThreshold !== null &&
      trade.amount >= shortThreshold;

    const zScoreEligible = zScoreTracker.getSampleCount() >= this.marketTradeZScoreMinSamples;
    const zScoreResult = zScoreEligible ? zScoreTracker.getZScore(trade.amount) : null;
    const shouldTriggerZScore =
      zScoreResult !== null && zScoreResult.zScore >= this.marketTradeZScoreThreshold;

    shortTracker.addSample(trade.timestamp, trade.amount);
    zScoreTracker.addSample(trade.timestamp, trade.amount);

    let triggered = false;

    if (shouldTriggerShort && shortThreshold !== null) {
      const alertType = this.getMarketTradeAlertType('SHORT_WINDOW_QUANTILE', direction);
      if (!(await this.databaseManager.hasRecentAlertOrPending(alertType, cutoff))) {
        const payload: MarketTradeStartPayload = {
          symbol: trade.symbol,
          timestamp: trade.timestamp,
          tradeId: trade.tradeId,
          direction,
          amount: trade.amount,
          strategy: 'SHORT_WINDOW_QUANTILE',
          threshold: shortThreshold,
          quantile: shortThreshold,
          quantileLevel: this.marketTradeShortQuantile,
          windowMinutes: shortTracker.getWindowMinutes(),
          sampleCount: shortSampleCount,
        };
        await this.databaseManager.enqueueAlert(alertType, payload, trade.timestamp);
        triggered = true;
      }
    }

    if (shouldTriggerZScore && zScoreResult) {
      const alertType = this.getMarketTradeAlertType('LOG_Z_SCORE', direction);
      if (!(await this.databaseManager.hasRecentAlertOrPending(alertType, cutoff))) {
        const payload: MarketTradeStartPayload = {
          symbol: trade.symbol,
          timestamp: trade.timestamp,
          tradeId: trade.tradeId,
          direction,
          amount: trade.amount,
          strategy: 'LOG_Z_SCORE',
          threshold: this.marketTradeZScoreThreshold,
          windowMinutes: zScoreTracker.getWindowMinutes(),
          sampleCount: zScoreResult.sampleCount,
          zScore: zScoreResult.zScore,
          zScoreThreshold: this.marketTradeZScoreThreshold,
          logMean: zScoreResult.mean,
          logStdDev: zScoreResult.std,
          logAmount: zScoreResult.logAmount,
        };
        await this.databaseManager.enqueueAlert(alertType, payload, trade.timestamp);
        triggered = true;
      }
    }

    if (triggered) {
      this.lastTradeStartTimestamp[direction] = trade.timestamp;
    }
  }

  private async evaluateCvdDeltaAlert(
    state: BucketState,
    bucketTimestamp: number,
    delta: number,
    zScore: number
  ): Promise<void> {
    if (!this.alertsEnabled) {
      return;
    }

    if (Math.abs(zScore) < this.threshold || Math.abs(delta) < 1e-8) {
      return;
    }

    const direction: 'buy' | 'sell' = delta >= 0 ? 'buy' : 'sell';
    const alertType = this.getCvdDeltaAlertType(state.config.spanMinutes, direction);
    const cutoff = Date.now() - this.suppressionWindowMs;

    if (await this.databaseManager.hasRecentAlertOrPending(alertType, cutoff)) {
      return;
    }

    const payload: CvdDeltaAlertPayload = {
      symbol: this.symbol,
      timestamp: bucketTimestamp,
      bucketSpanMinutes: state.config.spanMinutes,
      delta,
      zScore,
      threshold: this.threshold,
      direction,
      windowHours: state.config.windowMs / (60 * 60 * 1000),
    };

    await this.databaseManager.enqueueAlert(alertType, payload, bucketTimestamp);
  }

  private async evaluateCvdSlopeAlert(
    spanMinutes: number,
    bucketTimestamp: number,
    delta: number,
    slopeResult: SlopeUpdateResult
  ): Promise<void> {
    if (!this.alertsEnabled) {
      return;
    }

    if (slopeResult.normalized === null) {
      return;
    }

    const direction: 'buy' | 'sell' = delta >= 0 ? 'buy' : 'sell';
    const isBuyTrigger =
      direction === 'buy' && slopeResult.normalized >= this.cvdSlopeThreshold && slopeResult.slope > 0;
    const isSellTrigger =
      direction === 'sell' && slopeResult.normalized <= -this.cvdSlopeThreshold && slopeResult.slope < 0;

    if (!isBuyTrigger && !isSellTrigger) {
      return;
    }

    if (this.marketTradeLinkWindowMs > 0) {
      const lastStart = this.lastTradeStartTimestamp[direction];
      if (!lastStart || bucketTimestamp - lastStart > this.marketTradeLinkWindowMs) {
        return;
      }
    }

    const alertType = this.getCvdSlopeAlertType(spanMinutes, direction);
    const cutoff = Date.now() - this.suppressionWindowMs;
    if (await this.databaseManager.hasRecentAlertOrPending(alertType, cutoff)) {
      return;
    }

    const payload: CvdSlopeAlertPayload = {
      symbol: this.symbol,
      timestamp: bucketTimestamp,
      bucketSpanMinutes: spanMinutes,
      delta,
      slope: slopeResult.slope,
      slopeZ: slopeResult.normalized,
      threshold: this.cvdSlopeThreshold,
      direction,
      windowHours: this.cvdSlopeWindowMs / (60 * 60 * 1000),
    };

    await this.databaseManager.enqueueAlert(alertType, payload, bucketTimestamp);
  }

  private getSlopeTracker(spanMinutes: number): SlopeTracker {
    let tracker = this.slopeStates.get(spanMinutes);
    if (!tracker) {
      tracker = new SlopeTracker(this.cvdSlopeWindowMs, this.cvdSlopeAlpha);
      this.slopeStates.set(spanMinutes, tracker);
    }
    return tracker;
  }

  private filterTrades(rows: TradeDataRow[]): TradeDataRow[] {
    return rows
      .filter((row) => !row.isBlockTrade)
      .filter((row) => this.isTradeSymbolAllowed(row.symbol));
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

  private getTradeDelta(trade: TradeDataRow): number {
    return trade.direction === 'buy' ? trade.amount : -trade.amount;
  }

  private getBucketTimestamp(timestamp: number, spanMinutes: number): number {
    const bucketMs = spanMinutes * 60 * 1000;
    return Math.floor(timestamp / bucketMs) * bucketMs;
  }

  private getExistingDelta(state: BucketState, timestamp: number): number {
    const existing = state.history.find((item) => item.timestamp === timestamp);
    return existing ? existing.delta : 0;
  }

  private getComparisonValues(state: BucketState, targetTimestamp: number): number[] {
    return state.history.filter((item) => item.timestamp !== targetTimestamp).map((item) => item.delta);
  }

  private upsertHistoryEntry(state: BucketState, timestamp: number, delta: number): void {
    const existing = state.history.find((item) => item.timestamp === timestamp);
    if (existing) {
      existing.delta = delta;
    } else {
      state.history.push({ timestamp, delta });
    }
    state.history.sort((a, b) => a.timestamp - b.timestamp);

    const cutoff = timestamp - state.config.windowMs;
    state.history = state.history.filter((item) => item.timestamp >= cutoff);
  }

  private getCvdDeltaAlertType(spanMinutes: number, direction: 'buy' | 'sell'): string {
    const directionLabel = direction === 'buy' ? 'BUY' : 'SELL';
    return `CVD_DELTA_${spanMinutes}M_${directionLabel}`;
  }

  private getMarketTradeAlertType(strategy: MarketTradeStartStrategy, direction: 'buy' | 'sell'): string {
    const prefix =
      strategy === 'SHORT_WINDOW_QUANTILE'
        ? 'MARKET_TRADE_START_SHORT_WINDOW'
        : 'MARKET_TRADE_START_LOG_Z';
    return direction === 'buy' ? `${prefix}_BUY` : `${prefix}_SELL`;
  }

  private getCvdSlopeAlertType(spanMinutes: number, direction: 'buy' | 'sell'): string {
    const directionLabel = direction === 'buy' ? 'BUY' : 'SELL';
    return `CVD_SLOPE_${spanMinutes}M_${directionLabel}`;
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
