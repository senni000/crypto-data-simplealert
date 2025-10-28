import { EventEmitter } from 'events';
import { OptionData, TradeData } from '../types';

export interface DataHealthMonitorOptions {
  optionIntervalMs: number;
  optionGapToleranceMs?: number;
  tradeStaleThresholdMs?: number;
  checkIntervalMs?: number;
  sleepThresholdMs?: number;
  restErrorThreshold?: number;
  restErrorWindowMs?: number;
}

interface TradeDataStalePayload {
  staleMs: number;
  lastTradeTimestamp: number;
  detectedAt: string;
}

interface OptionDataDelayedPayload {
  delayMs: number;
  lastBatchTimestamp: number;
  detectedAt: string;
}

interface OptionGapPayload {
  gapMs: number;
  previousBatchTimestamp: number;
  currentBatchTimestamp: number;
  expectedIntervalMs: number;
  toleranceMs: number;
}

interface SystemResumePayload {
  gapMs: number;
  detectedAt: string;
  checkIntervalMs: number;
}

interface RestErrorSpikePayload {
  count: number;
  windowMs: number;
  detectedAt: string;
}

/**
 * Observes data collection flows and emits events when anomalies are detected.
 */
export class DataHealthMonitor extends EventEmitter {
  private readonly optionIntervalMs: number;
  private readonly optionGapToleranceMs: number;
  private readonly tradeStaleThresholdMs: number;
  private readonly checkIntervalMs: number;
  private readonly sleepThresholdMs: number;
  private readonly restErrorThreshold: number;
  private readonly restErrorWindowMs: number;

  private timer: NodeJS.Timeout | null = null;
  private lastCheckAt = Date.now();
  private lastTradeTimestamp: number | null = null;
  private lastOptionBatchTimestamp: number | null = null;
  private previousOptionBatchTimestamp: number | null = null;
  private tradeStaleReported = false;
  private optionDelayReported = false;
  private restErrorTimestamps: number[] = [];
  private restErrorSpikeReported = false;

  constructor(options: DataHealthMonitorOptions) {
    super();

    this.optionIntervalMs = options.optionIntervalMs;
    this.optionGapToleranceMs = options.optionGapToleranceMs ?? 5 * 60 * 1000;
    this.tradeStaleThresholdMs = options.tradeStaleThresholdMs ?? 5 * 60 * 1000;
    this.checkIntervalMs = options.checkIntervalMs ?? 60 * 1000;
    this.sleepThresholdMs = options.sleepThresholdMs ?? 2 * this.checkIntervalMs;
    this.restErrorThreshold = options.restErrorThreshold ?? 5;
    this.restErrorWindowMs = options.restErrorWindowMs ?? 10 * 60 * 1000;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.lastCheckAt = Date.now();
    this.timer = setInterval(() => this.evaluate(), this.checkIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  trackTradeData(trades: TradeData[]): void {
    if (trades.length === 0) {
      return;
    }

    const firstTrade = trades[0];

    if (!firstTrade) {
      return;
    }

    let latestTimestamp = this.lastTradeTimestamp ?? firstTrade.timestamp;

    for (const trade of trades) {
      if (trade.timestamp > latestTimestamp) {
        latestTimestamp = trade.timestamp;
      }
    }

    this.lastTradeTimestamp = latestTimestamp;
    this.tradeStaleReported = false;
  }

  markTradeBatchPersisted(): void {
    // Presence of persisted batches implies the stream is flowing again.
    this.tradeStaleReported = false;
  }

  trackOptionData(options: OptionData[]): void {
    if (options.length === 0) {
      return;
    }

    const batchTimestamp = options[0]?.timestamp;

    if (typeof batchTimestamp !== 'number') {
      return;
    }

    if (this.previousOptionBatchTimestamp !== null) {
      const gapMs = batchTimestamp - this.previousOptionBatchTimestamp;
      const expected = this.optionIntervalMs;
      const tolerance = this.optionGapToleranceMs;

      if (gapMs > expected + tolerance) {
        const payload: OptionGapPayload = {
          gapMs,
          previousBatchTimestamp: this.previousOptionBatchTimestamp,
          currentBatchTimestamp: batchTimestamp,
          expectedIntervalMs: expected,
          toleranceMs: tolerance,
        };

        this.emit('optionGapDetected', payload);
      }
    }

    this.previousOptionBatchTimestamp = batchTimestamp;
    this.lastOptionBatchTimestamp = batchTimestamp;
    this.optionDelayReported = false;
  }

  markOptionBatchPersisted(): void {
    this.optionDelayReported = false;
  }

  trackRestError(error: unknown): void {
    const now = Date.now();
    this.restErrorTimestamps.push(now);

    // Remove timestamps outside the monitoring window
    const windowStart = now - this.restErrorWindowMs;
    this.restErrorTimestamps = this.restErrorTimestamps.filter((timestamp) => timestamp >= windowStart);

    if (this.restErrorTimestamps.length >= this.restErrorThreshold && !this.restErrorSpikeReported) {
      const payload: RestErrorSpikePayload = {
        count: this.restErrorTimestamps.length,
        windowMs: this.restErrorWindowMs,
        detectedAt: new Date(now).toISOString(),
      };

      this.restErrorSpikeReported = true;
      this.emit('restErrorSpike', payload);
    } else if (this.restErrorTimestamps.length < this.restErrorThreshold) {
      this.restErrorSpikeReported = false;
    }

    this.emit('restErrorLogged', error);
  }

  markWebsocketDisconnected(): void {
    // Reset trade stale notification to allow re-check after disconnection.
    this.tradeStaleReported = false;
  }

  private evaluate(): void {
    const now = Date.now();
    const gapMs = now - this.lastCheckAt;

    if (gapMs > this.sleepThresholdMs) {
      const payload: SystemResumePayload = {
        gapMs,
        detectedAt: new Date(now).toISOString(),
        checkIntervalMs: this.checkIntervalMs,
      };

      this.emit('systemResumeDetected', payload);
    }

    this.lastCheckAt = now;

    if (this.lastTradeTimestamp !== null) {
      const staleMs = now - this.lastTradeTimestamp;

      if (staleMs > this.tradeStaleThresholdMs) {
        if (!this.tradeStaleReported) {
          const payload: TradeDataStalePayload = {
            staleMs,
            lastTradeTimestamp: this.lastTradeTimestamp,
            detectedAt: new Date(now).toISOString(),
          };

          this.tradeStaleReported = true;
          this.emit('tradeDataStale', payload);
        }
      } else {
        this.tradeStaleReported = false;
      }
    }

    if (this.lastOptionBatchTimestamp !== null) {
      const delayMs = now - this.lastOptionBatchTimestamp;
      const threshold = this.optionIntervalMs + this.optionGapToleranceMs;

      if (delayMs > threshold) {
        if (!this.optionDelayReported) {
          const payload: OptionDataDelayedPayload = {
            delayMs,
            lastBatchTimestamp: this.lastOptionBatchTimestamp,
            detectedAt: new Date(now).toISOString(),
          };

          this.optionDelayReported = true;
          this.emit('optionDataDelayed', payload);
        }
      } else {
        this.optionDelayReported = false;
      }
    }
  }
}
