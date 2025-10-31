/**
 * Analytics Alert Processor
 * Evaluates ratio and skew metrics to emit Discord alerts.
 */

import { EventEmitter } from 'events';
import {
  DeltaBucket,
  ExpiryType,
  OptionType,
  OrderFlowRatioData,
  SkewRawData,
  AlertMessage,
} from '../types';
import { IDatabaseManager } from './interfaces';
import { logger } from '../utils/logger';

export interface AnalyticsAlertProcessorOptions {
  ratioZScoreThreshold?: number;
  ratioDerivativeThreshold?: number;
  ratioMinThreshold?: number;
  callRrThreshold?: number;
  putRrThreshold?: number;
  callSlopeThreshold?: number;
  putSlopeThreshold?: number;
  dRrThreshold?: number;
  dSlopeThreshold?: number;
  comboLagMs?: number;
  ratioCooldownMinutes?: number;
  skewCooldownMinutes?: number;
  comboCooldownMinutes?: number;
  ratioLookbackMs?: number;
  skewLookbackMs?: number;
  comboZScoreFloor?: number;
}

type Direction = 'call' | 'put';

interface RatioSignal {
  expiryType: ExpiryType;
  optionType: OptionType;
  timestamp: number;
  ratio: number;
  zScore: number;
  derivative: number;
  triggerSource: 'zscore' | 'derivative';
  expiryTimestamp?: number;
}

interface SkewSignal {
  expiryType: ExpiryType;
  direction: Direction;
  timestamp: number;
  expiryTimestamp?: number;
  rr: number;
  dRr: number;
  slope: number;
  dSlope: number;
}

interface CombinedSkewRecord {
  timestamp: number;
  expiryTimestamp?: number;
  call: SkewRawData;
  put: SkewRawData;
}

const TARGET_EXPIRIES: ExpiryType[] = ['0DTE', 'Front'];
const TARGET_DELTA: DeltaBucket = '25D';
const MIN_SERIES_LENGTH = 5;
const STANDARD_DEVIATION_EPSILON = 1e-8;

export class AnalyticsAlertProcessor extends EventEmitter {
  private readonly databaseManager: IDatabaseManager;
  private readonly options: Required<AnalyticsAlertProcessorOptions>;
  private isProcessing = false;
  private lastComboAlertTimestamps = new Map<string, number>();
  private lastRatioSignals = new Map<string, RatioSignal>();
  private lastSkewSignals = new Map<string, SkewSignal>();

  constructor(
    databaseManager: IDatabaseManager,
    options: AnalyticsAlertProcessorOptions = {}
  ) {
    super();
    this.databaseManager = databaseManager;

    this.options = {
      ratioZScoreThreshold: options.ratioZScoreThreshold ?? 2.0,
      ratioDerivativeThreshold: options.ratioDerivativeThreshold ?? 3.0,
      ratioMinThreshold: options.ratioMinThreshold ?? 1.5,
      callRrThreshold: options.callRrThreshold ?? 3.0,
      putRrThreshold: options.putRrThreshold ?? 3.5,
      callSlopeThreshold: options.callSlopeThreshold ?? -5.0,
      putSlopeThreshold: options.putSlopeThreshold ?? 5.0,
      dRrThreshold: options.dRrThreshold ?? 0.02,
      dSlopeThreshold: options.dSlopeThreshold ?? 0.1,
      comboLagMs: options.comboLagMs ?? 2 * 60 * 1000,
      ratioCooldownMinutes: options.ratioCooldownMinutes ?? 5,
      skewCooldownMinutes: options.skewCooldownMinutes ?? 5,
      comboCooldownMinutes: options.comboCooldownMinutes ?? 5,
      ratioLookbackMs: options.ratioLookbackMs ?? 24 * 60 * 60 * 1000,
      skewLookbackMs: options.skewLookbackMs ?? 24 * 60 * 60 * 1000,
      comboZScoreFloor: options.comboZScoreFloor ?? 0.5,
    };
  }

  /**
   * Process latest analytics data (triggered after each collection cycle)
   */
  async processLatestAnalytics(triggerTimestamp: number): Promise<void> {
    if (this.isProcessing) {
      logger.debug('Analytics alert processing already in progress, skipping cycle');
      return;
    }

    this.isProcessing = true;
    try {
      for (const expiryType of TARGET_EXPIRIES) {
        await this.evaluateExpiry(expiryType, triggerTimestamp);
      }
    } catch (error) {
      logger.error('Failed to process analytics alerts', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async evaluateExpiry(expiryType: ExpiryType, triggerTimestamp: number): Promise<void> {
    const ratioSignals: RatioSignal[] = [];
    const skewSignals: SkewSignal[] = [];
    const sinceRatio = triggerTimestamp - this.options.ratioLookbackMs;
    const sinceSkew = triggerTimestamp - this.options.skewLookbackMs;

    for (const optionType of ['call', 'put'] as OptionType[]) {
      const ratioSeries = await this.databaseManager.getOrderFlowRatioSeries({
        expiryType,
        deltaBucket: TARGET_DELTA,
        optionType,
        since: sinceRatio,
      });
      const ratioSignal = this.calculateRatioSignal(ratioSeries, expiryType, optionType);
      if (ratioSignal) {
        ratioSignals.push(ratioSignal);
      }
    }

    const callSkewSeries = await this.databaseManager.getSkewRawSeries({
      expiryType,
      deltaBucket: TARGET_DELTA,
      optionType: 'call',
      since: sinceSkew,
    });
    const putSkewSeries = await this.databaseManager.getSkewRawSeries({
      expiryType,
      deltaBucket: TARGET_DELTA,
      optionType: 'put',
      since: sinceSkew,
    });
    const combinedSkew = this.combineSkewSeries(callSkewSeries, putSkewSeries);
    const skewResults = this.calculateSkewSignals(combinedSkew, expiryType);
    if (skewResults.call) {
      skewSignals.push(skewResults.call);
    }
    if (skewResults.put) {
      skewSignals.push(skewResults.put);
    }

    for (const ratioSignal of ratioSignals) {
      await this.processRatioSignal(ratioSignal);
    }

    for (const skewSignal of skewSignals) {
      await this.processSkewSignal(skewSignal);
    }
  }

  private calculateRatioSignal(
    series: OrderFlowRatioData[],
    expiryType: ExpiryType,
    optionType: OptionType
  ): RatioSignal | null {
    if (!series || series.length < MIN_SERIES_LENGTH) {
      return null;
    }

    const aggregated = this.collapseSeriesByMinute(series);
    if (aggregated.length < 2) {
      return null;
    }

    const latest = aggregated[aggregated.length - 1];
    if (!latest) {
      return null;
    }

    const previous = this.findPreviousEntry(aggregated, latest.timestamp);
    if (!previous) {
      return null;
    }

    const mean = aggregated.reduce((acc, item) => acc + item.ratio, 0) / aggregated.length;
    const variance =
      aggregated.reduce((acc, item) => {
        const diff = item.ratio - mean;
        return acc + diff * diff;
      }, 0) / aggregated.length;

    const std = Math.sqrt(variance);
    const zScore = std > STANDARD_DEVIATION_EPSILON ? (latest.ratio - mean) / std : 0;
    const derivative = latest.ratio - previous.ratio;

    const triggeredByZ = zScore >= this.options.ratioZScoreThreshold;
    const triggeredByDerivative = derivative >= this.options.ratioDerivativeThreshold;

    if (!triggeredByZ && !triggeredByDerivative) {
      return null;
    }

    if (latest.ratio < this.options.ratioMinThreshold) {
      return null;
    }

    const triggerSource = triggeredByZ ? 'zscore' : 'derivative';

    const signal: RatioSignal = {
      expiryType,
      optionType,
      timestamp: latest.timestamp,
      ratio: latest.ratio,
      zScore,
      derivative,
      triggerSource,
    };

    if (typeof latest.expiryTimestamp === 'number') {
      signal.expiryTimestamp = latest.expiryTimestamp;
    }

    return signal;
  }

  private calculateSkewSignals(
    combined: CombinedSkewRecord[],
    expiryType: ExpiryType
  ): { call?: SkewSignal; put?: SkewSignal } {
    if (!combined || combined.length < 2) {
      return {};
    }

    const latest = combined[combined.length - 1];
    const previous = combined[combined.length - 2];

    if (!latest || !previous) {
      return {};
    }

    const latestDiff = latest.put.markIv - latest.call.markIv;
    const previousDiff = previous.put.markIv - previous.call.markIv;

    const rr = latestDiff;
    const dRr = rr - previousDiff;
    const slope = latestDiff / 0.5;
    const prevSlope = previousDiff / 0.5;
    const dSlope = slope - prevSlope;

    const signals: { call?: SkewSignal; put?: SkewSignal } = {};

    const callTriggered =
      rr <= this.options.callRrThreshold ||
      slope <= this.options.callSlopeThreshold ||
      dRr <= -this.options.dRrThreshold ||
      dSlope <= -this.options.dSlopeThreshold;

    if (callTriggered) {
      const callSignal: SkewSignal = {
        expiryType,
        direction: 'call',
        timestamp: latest.timestamp,
        rr,
        dRr,
        slope,
        dSlope,
      };
      if (typeof latest.expiryTimestamp === 'number') {
        callSignal.expiryTimestamp = latest.expiryTimestamp;
      }
      signals.call = callSignal;
    }

    const putTriggered =
      rr >= this.options.putRrThreshold ||
      slope >= this.options.putSlopeThreshold ||
      dRr >= this.options.dRrThreshold ||
      dSlope >= this.options.dSlopeThreshold;

    if (putTriggered) {
      const putSignal: SkewSignal = {
        expiryType,
        direction: 'put',
        timestamp: latest.timestamp,
        rr,
        dRr,
        slope,
        dSlope,
      };
      if (typeof latest.expiryTimestamp === 'number') {
        putSignal.expiryTimestamp = latest.expiryTimestamp;
      }
      signals.put = putSignal;
    }

    return signals;
  }

  private async processRatioSignal(signal: RatioSignal): Promise<void> {
    const ratioSignalKey = this.makeKey('RATIO_SIGNAL', signal.expiryType, signal.optionType);
    this.lastRatioSignals.set(ratioSignalKey, signal);
    await this.trySendComboAlert(signal.expiryType, signal.optionType, signal.optionType);
  }

  private async processSkewSignal(signal: SkewSignal): Promise<void> {
    const skewSignalKey = this.makeKey('SKEW_SIGNAL', signal.expiryType, signal.direction);
    this.lastSkewSignals.set(skewSignalKey, signal);
    const ratioOption: OptionType = signal.direction === 'call' ? 'call' : 'put';
    await this.trySendComboAlert(signal.expiryType, signal.direction, ratioOption);
  }

  private async trySendComboAlert(
    expiryType: ExpiryType,
    direction: Direction,
    ratioOptionType?: OptionType
  ): Promise<void> {
    const ratioKey = this.makeKey('RATIO_SIGNAL', expiryType, ratioOptionType ?? (direction as OptionType));
    const skewKey = this.makeKey('SKEW_SIGNAL', expiryType, direction);

    const ratioSignal = this.lastRatioSignals.get(ratioKey);
    const skewSignal = this.lastSkewSignals.get(skewKey);

    if (!ratioSignal || !skewSignal) {
      return;
    }

    if (ratioSignal.zScore < this.options.comboZScoreFloor) {
      return;
    }

    const ratioTimestamp = ratioSignal.timestamp;
    const skewTimestamp = skewSignal.timestamp;

    const maxTimestamp = Math.max(ratioTimestamp, skewTimestamp);
    const minTimestamp = Math.min(ratioTimestamp, skewTimestamp);

    if (maxTimestamp - minTimestamp > this.options.comboLagMs) {
      return;
    }

    if (ratioTimestamp < skewTimestamp) {
      // Prefer skew leading or same timestamp
      return;
    }

    const alertType = direction === 'call' ? 'COMBO_CALL' : 'COMBO_PUT';
    const alertKey = this.makeKey(alertType, expiryType);

    if (
      !(await this.shouldSendAlert(
        alertKey,
        this.lastComboAlertTimestamps,
        ratioTimestamp,
        this.options.comboCooldownMinutes
      ))
    ) {
      return;
    }

    const comboMessage = [
      '[COMBO ALERT 🚨]',
      `${expiryType} | 25Δ | ${direction.toUpperCase()}`,
      `ratio: ${ratioSignal.ratio.toFixed(2)} (Z=${ratioSignal.zScore.toFixed(2)}, dR/dt=${this.formatSigned(
        ratioSignal.derivative,
        2
      )})`,
      `RR: ${skewSignal.rr.toFixed(3)} (dRR/dt=${this.formatSigned(skewSignal.dRr, 3)})`,
      `Slope: ${skewSignal.slope.toFixed(3)} (dSlope/dt=${this.formatSigned(skewSignal.dSlope, 3)})`,
      direction === 'call'
        ? '→ CALL Skew Spike + Bid dominance\n>>> STRONG BUY PRESSURE SIGNAL ⚡'
        : '→ PUT Skew Spike + Bid dominance\n>>> STRONG SELL PRESSURE SIGNAL ⚡',
    ].join('\n');

    const alertMessage: AlertMessage = {
      type: alertType,
      timestamp: ratioTimestamp,
      value: ratioSignal.ratio,
      threshold: this.options.ratioZScoreThreshold,
      message: comboMessage,
    };

    try {
      await this.databaseManager.saveAlertHistory({
        alertType: alertMessage.type,
        timestamp: alertMessage.timestamp,
        value: alertMessage.value,
        threshold: alertMessage.threshold,
        message: alertMessage.message,
      });
      logger.debug('Persisted combo alert without notification', {
        alertType,
        expiryType,
        direction,
      });
    } catch (error) {
      logger.error('Failed to persist combo alert history', error);
      return;
    }

    this.lastComboAlertTimestamps.set(alertKey, ratioTimestamp);
    this.emit('comboAlert', alertMessage);
  }

  private collapseSeriesByMinute(series: OrderFlowRatioData[]): Array<OrderFlowRatioData & { timestamp: number }> {
    const map = new Map<number, OrderFlowRatioData>();

    for (const item of series) {
      const bucket = this.bucketTimestamp(item.timestamp);
      const existing = map.get(bucket);
      if (!existing || item.timestamp > existing.timestamp) {
        map.set(bucket, { ...item, timestamp: bucket });
      }
    }

    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, record]) => ({ ...record, timestamp }));
  }

  private combineSkewSeries(callSeries: SkewRawData[], putSeries: SkewRawData[]): CombinedSkewRecord[] {
    const map = new Map<number, { call?: SkewRawData; put?: SkewRawData }>();

    for (const call of callSeries) {
      const bucket = this.bucketTimestamp(call.timestamp);
      const entry = map.get(bucket) ?? {};
      entry.call = call;
      map.set(bucket, entry);
    }

    for (const put of putSeries) {
      const bucket = this.bucketTimestamp(put.timestamp);
      const entry = map.get(bucket) ?? {};
      entry.put = put;
      map.set(bucket, entry);
    }

    return Array.from(map.entries())
      .filter(([, entry]) => entry.call && entry.put)
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, entry]) => {
        const record: CombinedSkewRecord = {
          timestamp,
          call: entry.call as SkewRawData,
          put: entry.put as SkewRawData,
        };

        const expiryTimestamp = entry.call?.expiryTimestamp ?? entry.put?.expiryTimestamp;
        if (typeof expiryTimestamp === 'number') {
          record.expiryTimestamp = expiryTimestamp;
        }

        return record;
      });
  }

  private async shouldSendAlert(
    alertKey: string,
    cache: Map<string, number>,
    timestamp: number,
    cooldownMinutes: number
  ): Promise<boolean> {
    const lastTimestamp = cache.get(alertKey);
    if (lastTimestamp && timestamp <= lastTimestamp) {
      return false;
    }

    if (lastTimestamp && timestamp - lastTimestamp < cooldownMinutes * 60 * 1000) {
      return false;
    }

    cache.set(alertKey, timestamp);
    return true;
  }

  private findPreviousEntry(
    series: Array<OrderFlowRatioData & { timestamp: number }>,
    targetTimestamp: number
  ): OrderFlowRatioData & { timestamp: number } | null {
    for (let i = series.length - 2; i >= 0; i--) {
      const candidate = series[i];
      if (candidate && candidate.timestamp < targetTimestamp) {
        return candidate;
      }
    }
    return null;
  }

  private bucketTimestamp(timestamp: number): number {
    return Math.floor(timestamp / 60000) * 60000;
  }

  private formatSigned(value: number, fractionDigits: number): string {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(fractionDigits)}`;
  }

  private makeKey(base: string, expiryType: ExpiryType, optionType?: OptionType | Direction): string {
    return [base, expiryType, optionType ?? ''].filter(Boolean).join('-');
  }
}
