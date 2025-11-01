import { EventEmitter } from 'events';
import { ZScoreCalculator } from '@crypto-data/cvd-core';
import { IDatabaseManager, ProcessingState } from './interfaces';
import {
  TradeDataRow,
  CvdDeltaAlertPayload,
  MarketTradeStartPayload,
  CvdSlopeAlertPayload,
} from '../types';
import { logger } from '../utils/logger';

export interface CvdAggregationWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  suppressionWindowMinutes?: number;
  bucketSpansMinutes?: number[];
  historyWindowHours?: number;
  marketTradeWindowHours?: number;
  marketTradePrimaryQuantile?: number;
  marketTradeSecondaryQuantile?: number;
  marketTradeMinSamples?: number;
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

const DEFAULT_MARKET_TRADE_WINDOW_HOURS = 72;
const DEFAULT_PRIMARY_QUANTILE = 0.99;
const DEFAULT_SECONDARY_QUANTILE = 0.95;
const DEFAULT_MIN_SAMPLES = 500;
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

class TradeAmountTracker {
  private readonly minLog: number;
  private readonly maxLog: number;
  private readonly step: number;
  private readonly counts: number[];
  private readonly entries: Array<{ timestamp: number; amount: number; bucket: number }> = [];
  private head = 0;
  private total = 0;

  constructor(
    private readonly windowMs: number,
    private readonly bucketCount = 256,
    minAmount = 1,
    maxAmount = 100_000_000
  ) {
    this.minLog = Math.log10(Math.max(1e-6, minAmount));
    this.maxLog = Math.log10(Math.max(minAmount * 10, maxAmount));
    this.step = (this.maxLog - this.minLog) / this.bucketCount;
    this.counts = new Array(bucketCount).fill(0);
  }

  add(timestamp: number, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.prune(timestamp);
    const bucket = this.getBucketIndex(amount);
    this.entries.push({ timestamp, amount, bucket });
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
    this.total += 1;
  }

  hasSamples(minSamples: number): boolean {
    return this.total >= minSamples;
  }

  getQuantile(probability: number): number | null {
    if (this.total === 0) {
      return null;
    }
    const target = clamp(probability, 0, 1) * (this.total - 1);
    let cumulative = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      const count = this.counts[index] ?? 0;
      if (count <= 0) {
        continue;
      }
      if (cumulative + count > target) {
        const fraction = (target - cumulative) / count;
        return this.bucketToValue(index, fraction);
      }
      cumulative += count;
    }
    return this.bucketToValue(this.counts.length - 1, 1);
  }

  getIqrScale(): number | null {
    const q1 = this.getQuantile(0.25);
    const q3 = this.getQuantile(0.75);
    if (q1 === null || q3 === null) {
      return null;
    }
    const iqr = q3 - q1;
    if (iqr <= 0) {
      return null;
    }
    return iqr / 1.349; // Approximate conversion to standard deviation
  }

  getWindowHours(): number {
    return this.windowMs / (60 * 60 * 1000);
  }

  private prune(currentTimestamp: number): void {
    const cutoff = currentTimestamp - this.windowMs;
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head];
      if (!entry || entry.timestamp >= cutoff) {
        break;
      }
      if (entry.bucket >= 0 && entry.bucket < this.counts.length) {
        const current = this.counts[entry.bucket] ?? 0;
        this.counts[entry.bucket] = current > 0 ? current - 1 : 0;
      }
      this.total -= 1;
      this.head += 1;
    }
    if (this.head > 4096 && this.head > this.entries.length / 2) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }

  private getBucketIndex(amount: number): number {
    const logAmount = Math.log10(amount);
    const position = (logAmount - this.minLog) / this.step;
    const index = Math.floor(clamp(position, 0, this.bucketCount - 1));
    return index;
  }

  private bucketToValue(index: number, fraction: number): number {
    const lowerLog = this.minLog + index * this.step;
    const upperLog = lowerLog + this.step;
    const valueLog = lowerLog + clamp(fraction, 0, 1) * (upperLog - lowerLog);
    return 10 ** valueLog;
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

  private readonly marketTradeWindowMs: number;
  private readonly marketTradePrimaryQuantile: number;
  private readonly marketTradeSecondaryQuantile: number;
  private readonly marketTradeMinSamples: number;
  private readonly marketTradeLinkWindowMs: number;
  private readonly cvdSlopeThreshold: number;
  private readonly cvdSlopeAlpha: number;
  private readonly cvdSlopeWindowMs: number;

  private readonly bucketStates = new Map<number, BucketState>();
  private readonly tradeTrackers: Record<'buy' | 'sell', TradeAmountTracker>;
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

    const historyWindowHours = Math.max(1, Math.floor(options.historyWindowHours ?? DEFAULT_MARKET_TRADE_WINDOW_HOURS));
    const historyWindowMs = historyWindowHours * 60 * 60 * 1000;
    const spans = options.bucketSpansMinutes && options.bucketSpansMinutes.length > 0 ? options.bucketSpansMinutes : [5, 30];
    this.bucketConfigs = spans.map((spanMinutes) => ({ spanMinutes, windowMs: historyWindowMs }));

    this.marketTradeWindowMs = Math.max(
      1,
      Math.floor((options.marketTradeWindowHours ?? DEFAULT_MARKET_TRADE_WINDOW_HOURS) * 60 * 60 * 1000)
    );
    this.marketTradePrimaryQuantile = clamp(
      options.marketTradePrimaryQuantile ?? DEFAULT_PRIMARY_QUANTILE,
      0.5,
      0.9999
    );
    this.marketTradeSecondaryQuantile = clamp(
      options.marketTradeSecondaryQuantile ?? DEFAULT_SECONDARY_QUANTILE,
      0.5,
      this.marketTradePrimaryQuantile
    );
    this.marketTradeMinSamples = Math.max(10, Math.floor(options.marketTradeMinSamples ?? DEFAULT_MIN_SAMPLES));
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

    this.tradeTrackers = {
      buy: new TradeAmountTracker(this.marketTradeWindowMs),
      sell: new TradeAmountTracker(this.marketTradeWindowMs),
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
    const tracker = this.tradeTrackers[direction];
    tracker.add(trade.timestamp, trade.amount);

    if (!tracker.hasSamples(this.marketTradeMinSamples)) {
      return;
    }

    const primaryThreshold = tracker.getQuantile(this.marketTradePrimaryQuantile);
    if (primaryThreshold === null || trade.amount < primaryThreshold) {
      return;
    }

    const alertType = this.getMarketTradeStartAlertType(direction);
    const cutoff = Date.now() - this.suppressionWindowMs;

    if (!(await this.databaseManager.hasRecentAlertOrPending(alertType, cutoff))) {
      const secondary = tracker.getQuantile(this.marketTradeSecondaryQuantile);
      const scale = tracker.getIqrScale();
      const payload: MarketTradeStartPayload = {
        symbol: trade.symbol,
        timestamp: trade.timestamp,
        tradeId: trade.tradeId,
        direction,
        amount: trade.amount,
        quantile: primaryThreshold,
        quantileLevel: this.marketTradePrimaryQuantile,
        threshold: primaryThreshold,
        windowHours: tracker.getWindowHours(),
      };
      if (secondary !== null && secondary !== undefined) {
        payload.secondaryQuantile = secondary;
      }
      if (scale !== null && scale !== undefined) {
        payload.scale = scale;
      }

      await this.databaseManager.enqueueAlert(alertType, payload, trade.timestamp);
    }

    this.lastTradeStartTimestamp[direction] = trade.timestamp;
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

  private getMarketTradeStartAlertType(direction: 'buy' | 'sell'): string {
    return direction === 'buy' ? 'MARKET_TRADE_START_BUY' : 'MARKET_TRADE_START_SELL';
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
