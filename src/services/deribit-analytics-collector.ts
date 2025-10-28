/**
 * Deribit analytics data collector
 * - 板圧力（Bid/Ask Ratio）
 * - Skew Impulse向けの生データ
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import {
  DeltaBucket,
  ExpiryType,
  OptionType,
  OrderFlowRatioData,
  SkewRawData,
} from '../types';
import { IDatabaseManager } from './interfaces';
import { logger } from '../utils/logger';

type SettlementPeriod = 'day' | 'week' | 'month' | 'quarter' | string;

interface DeribitInstrument {
  instrument_name: string;
  expiration_timestamp: number;
  option_type: OptionType;
  settlement_period: SettlementPeriod;
  is_active: boolean;
}

interface OrderBookResponse {
  timestamp: number;
  instrument_name: string;
  index_price: number;
  mark_price: number;
  mark_iv: number;
  best_bid_price: number | null;
  best_ask_price: number | null;
  bids?: Array<[number, number]>;
  asks?: Array<[number, number]>;
  greeks?: {
    delta: number;
  };
}

interface InstrumentSnapshot {
  instrument: DeribitInstrument;
  delta: number | null;
}

interface SelectedInstrument extends InstrumentSnapshot {
  expiryType: ExpiryType;
  expiryTimestamp: number;
}

type InstrumentBucket = Partial<Record<OptionType, SelectedInstrument>>;

type InstrumentSelectionMap = Partial<Record<ExpiryType, Partial<Record<DeltaBucket, InstrumentBucket>>>>;

export interface DeribitAnalyticsCollectorOptions {
  apiUrl?: string;
  intervalMs?: number;
  instrumentRefreshIntervalMs?: number;
  ratioPriceWindowUsd?: number;
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const TARGET_DELTA: Record<DeltaBucket, number> = {
  '10D': 0.1,
  '25D': 0.25,
  ATM: 0.5,
};

const OPTION_TYPES: OptionType[] = ['call', 'put'];

/**
 * Deribit Public APIから指定銘柄の板情報を収集し、指標を算出・保存するクラス
 */
export class DeribitAnalyticsCollector extends EventEmitter {
  private readonly databaseManager: IDatabaseManager;
  private readonly axiosInstance: AxiosInstance;
  private readonly options: Required<DeribitAnalyticsCollectorOptions>;
  private instrumentSelection: InstrumentSelectionMap = {};
  private collectionTimer: NodeJS.Timeout | null = null;
  private instrumentRefreshTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isCollectingInProgress = false;
  private collectionPromise: Promise<void> | null = null;

  constructor(databaseManager: IDatabaseManager, options: DeribitAnalyticsCollectorOptions = {}) {
    super();
    this.databaseManager = databaseManager;

    this.options = {
      apiUrl: options.apiUrl ?? 'https://www.deribit.com/api/v2',
      intervalMs: options.intervalMs ?? 60_000,
      instrumentRefreshIntervalMs: options.instrumentRefreshIntervalMs ?? 60 * 60 * 1000,
      ratioPriceWindowUsd: options.ratioPriceWindowUsd ?? 5,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 5,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1_000,
    };

    this.axiosInstance = axios.create({
      baseURL: this.options.apiUrl,
      timeout: this.options.requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * 現在の稼働状態を取得
   */
  isCollecting(): boolean {
    return this.isRunning;
  }

  /**
   * 収集開始
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('DeribitAnalyticsCollector already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting Deribit analytics collector');

    const refreshed = await this.refreshInstruments();
    if (!refreshed) {
      throw new Error('Failed to refresh Deribit instrument selection');
    }
    await this.triggerCollection();

    this.collectionTimer = setInterval(() => {
      void this.triggerCollection();
    }, this.options.intervalMs);

    this.instrumentRefreshTimer = setInterval(() => {
      void this.refreshInstruments();
    }, this.options.instrumentRefreshIntervalMs);
  }

  /**
   * 収集停止
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }

    if (this.instrumentRefreshTimer) {
      clearInterval(this.instrumentRefreshTimer);
      this.instrumentRefreshTimer = null;
    }

    logger.info('Stopped Deribit analytics collector');

    if (this.collectionPromise) {
      await this.collectionPromise;
    }
  }

  /**
   * 現在の銘柄選定状態を取得（テスト向け）
   */
  getInstrumentSelection(): InstrumentSelectionMap {
    return this.instrumentSelection;
  }

  private async triggerCollection(): Promise<void> {
    if (!this.isRunning || this.isCollectingInProgress) {
      return;
    }

    if (!this.hasAnyInstrumentSelected()) {
      logger.warn('No instruments selected for analytics collection. Skipping run.');
      return;
    }

    this.isCollectingInProgress = true;
    this.collectionPromise = this.collectOnce()
      .catch((error) => {
        logger.error('Failed to collect Deribit analytics data', error);
        this.emit('error', error);
      })
      .finally(() => {
        this.isCollectingInProgress = false;
        this.collectionPromise = null;
      });

    await this.collectionPromise;
  }

  private hasAnyInstrumentSelected(): boolean {
    return Object.values(this.instrumentSelection).some((deltaMap) =>
      deltaMap && Object.values(deltaMap).some((bucket) =>
        bucket && OPTION_TYPES.some((type) => bucket[type])
      )
    );
  }

  private async collectOnce(): Promise<void> {
    const ratioRecords: OrderFlowRatioData[] = [];
    const skewRecords: SkewRawData[] = [];

    const tasks: Array<() => Promise<void>> = [];

    for (const expiryType of Object.keys(this.instrumentSelection) as ExpiryType[]) {
      const bucketMap = this.instrumentSelection[expiryType];
      if (!bucketMap) continue;

      for (const deltaBucket of Object.keys(bucketMap) as DeltaBucket[]) {
        const instruments = bucketMap[deltaBucket];
        if (!instruments) continue;

        for (const optionType of OPTION_TYPES) {
          const selection = instruments[optionType];
          if (!selection) continue;

          tasks.push(async () => {
            const orderBook = await this.getOrderBook(selection.instrument.instrument_name);
            if (!orderBook) {
              return;
            }

            const ratio = this.calculateBidAskRatio(orderBook, this.options.ratioPriceWindowUsd);
            ratioRecords.push({
              timestamp: orderBook.timestamp,
              expiryType,
              expiryTimestamp: selection.expiryTimestamp,
              deltaBucket,
              optionType,
              ratio,
            });

            skewRecords.push({
              timestamp: orderBook.timestamp,
              expiryType,
              expiryTimestamp: selection.expiryTimestamp,
              deltaBucket,
              optionType,
              markIv: orderBook.mark_iv ?? 0,
              markPrice: orderBook.mark_price ?? 0,
              delta: orderBook.greeks?.delta ?? 0,
              indexPrice: orderBook.index_price ?? 0,
            });
          });
        }
      }
    }

    await this.runWithConcurrency(tasks, this.options.maxConcurrentRequests);

    if (ratioRecords.length > 0) {
      await this.databaseManager.saveOrderFlowRatioData(ratioRecords);
      this.emit('ratioDataSaved', ratioRecords.length);
    }

    if (skewRecords.length > 0) {
      await this.databaseManager.saveSkewRawData(skewRecords);
      this.emit('skewDataSaved', skewRecords.length);
    }

    this.emit('collectionCompleted', {
      ratioCount: ratioRecords.length,
      skewCount: skewRecords.length,
      timestamp: Date.now(),
    });
  }

  private async refreshInstruments(): Promise<boolean> {
    try {
      const instruments = await this.getBTCOptionInstruments();
      const grouped = this.groupInstrumentsByExpiry(instruments);
      const selection: InstrumentSelectionMap = {};

      for (const expiryType of Object.keys(grouped) as ExpiryType[]) {
        const candidates = grouped[expiryType];
        if (!candidates || candidates.length === 0) {
          continue;
        }

        const snapshots = await this.enrichWithDelta(candidates);
        selection[expiryType] = this.selectByDeltaBucket(expiryType, snapshots);
      }

      this.instrumentSelection = selection;
      this.emit('instrumentsUpdated', selection);
      logger.info('Updated Deribit analytics instrument selection', this.summarizeSelection(selection));
      return true;
    } catch (error) {
      logger.error('Failed to refresh instrument selections', error);
      this.emit('error', error);
      return false;
    }
  }

  private summarizeSelection(selection: InstrumentSelectionMap): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const expiryType of Object.keys(selection) as ExpiryType[]) {
      const bucketMap = selection[expiryType];
      if (!bucketMap) continue;

      summary[expiryType] = Object.fromEntries(
        (Object.keys(bucketMap) as DeltaBucket[]).map((bucket) => {
          const instruments = bucketMap[bucket];
          if (!instruments) {
            return [bucket, null];
          }

          return [
            bucket,
            Object.fromEntries(
              OPTION_TYPES.map((optionType) => {
                const instrument = instruments[optionType];
                return [
                  optionType,
                  instrument
                    ? {
                        name: instrument.instrument.instrument_name,
                        delta: instrument.delta,
                      }
                    : null,
                ];
              })
            ),
          ];
        })
      );
    }
    return summary;
  }

  private async getBTCOptionInstruments(): Promise<DeribitInstrument[]> {
    const response = await this.makeRequest<{ result: DeribitInstrument[] }>(
      '/public/get_instruments',
      {
        currency: 'BTC',
        kind: 'option',
        expired: false,
      }
    );

    return response.result.filter((instrument) => instrument.is_active);
  }

  private groupInstrumentsByExpiry(instruments: DeribitInstrument[]): Partial<Record<ExpiryType, DeribitInstrument[]>> {
    const now = new Date();
    const nowMs = now.getTime();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrowUtc = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000);

    const result: Partial<Record<ExpiryType, DeribitInstrument[]>> = {};

    const daily = instruments.filter((instrument) => {
      const expiry = new Date(instrument.expiration_timestamp);
      return (
        instrument.settlement_period === 'day' &&
        expiry >= todayUtc &&
        expiry < tomorrowUtc
      );
    });
    if (daily.length > 0) {
      result['0DTE'] = daily;
    }

    const monthly = instruments
      .filter((instrument) => instrument.settlement_period === 'month' && instrument.expiration_timestamp > nowMs)
      .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);

    const uniqueMonthlyExpiries = Array.from(
      new Set(monthly.map((instrument) => instrument.expiration_timestamp))
    ).sort((a, b) => a - b);

    if (uniqueMonthlyExpiries.length > 0) {
      const frontExpiry = uniqueMonthlyExpiries[0];
      result['Front'] = monthly.filter((instrument) => instrument.expiration_timestamp === frontExpiry);
    }

    if (uniqueMonthlyExpiries.length > 1) {
      const nextExpiry = uniqueMonthlyExpiries[1];
      result['Next'] = monthly.filter((instrument) => instrument.expiration_timestamp === nextExpiry);
    }

    const quarterly = instruments
      .filter((instrument) => instrument.settlement_period === 'quarter' && instrument.expiration_timestamp > nowMs)
      .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);

    if (quarterly.length > 0) {
      const firstQuarterInstrument = quarterly[0];
      if (firstQuarterInstrument) {
        const firstQuarter = firstQuarterInstrument.expiration_timestamp;
        result['Quarterly'] = quarterly.filter(
          (instrument) => instrument.expiration_timestamp === firstQuarter
        );
      }
    }

    return result;
  }

  private async enrichWithDelta(instruments: DeribitInstrument[]): Promise<InstrumentSnapshot[]> {
    const snapshots: InstrumentSnapshot[] = [];

    const tasks = instruments.map(
      (instrument) => async () => {
        const ticker = await this.getTicker(instrument.instrument_name);
        const delta = ticker?.greeks?.delta ?? null;
        snapshots.push({
          instrument,
          delta,
        });
      }
    );

    await this.runWithConcurrency(tasks, this.options.maxConcurrentRequests);

    return snapshots;
  }

  private selectByDeltaBucket(expiryType: ExpiryType, snapshots: InstrumentSnapshot[]): Partial<Record<DeltaBucket, InstrumentBucket>> {
    const selection: Partial<Record<DeltaBucket, InstrumentBucket>> = {};

    for (const bucket of Object.keys(TARGET_DELTA) as DeltaBucket[]) {
      const target = TARGET_DELTA[bucket];
      const bucketSelection: InstrumentBucket = {};

      for (const optionType of OPTION_TYPES) {
        const candidates = snapshots.filter(
          (snapshot) => snapshot.instrument.option_type === optionType && snapshot.delta !== null
        );

        if (candidates.length === 0) {
          continue;
        }

        const selected = candidates.reduce<InstrumentSnapshot | null>((best, current) => {
          if (current.delta === null) {
            return best;
          }

          const currentScore = Math.abs(Math.abs(current.delta) - target);
          if (!best || best.delta === null) {
            return current;
          }

          const bestScore = Math.abs(Math.abs(best.delta) - target);
          return currentScore < bestScore ? current : best;
        }, null);

        if (selected) {
          bucketSelection[optionType] = {
            ...selected,
            expiryType,
            expiryTimestamp: selected.instrument.expiration_timestamp,
          };
        }
      }

      if (Object.keys(bucketSelection).length > 0) {
        selection[bucket] = bucketSelection;
      }
    }

    return selection;
  }

  private calculateBidAskRatio(orderBook: OrderBookResponse, priceWindowUsd: number): number {
    const fallbackBid = orderBook.bids?.[0]?.[0] ?? 0;
    const fallbackAsk = orderBook.asks?.[0]?.[0] ?? fallbackBid;

    const bestBidPrice = orderBook.best_bid_price ?? fallbackBid;
    const bestAskPrice = orderBook.best_ask_price ?? fallbackAsk;
    const indexPrice = orderBook.index_price ?? 0;

    if (indexPrice <= 0) {
      return 0;
    }

    const priceWindowBtc = priceWindowUsd / indexPrice;
    const bidLower = bestBidPrice - priceWindowBtc;
    const bidUpper = bestBidPrice + priceWindowBtc;
    const askLower = bestAskPrice - priceWindowBtc;
    const askUpper = bestAskPrice + priceWindowBtc;

    const bidVolume = (orderBook.bids ?? [])
      .filter(([price]) => price >= bidLower && price <= bidUpper)
      .reduce((acc, [, amount]) => acc + amount, 0);

    const askVolume = (orderBook.asks ?? [])
      .filter(([price]) => price >= askLower && price <= askUpper)
      .reduce((acc, [, amount]) => acc + amount, 0);

    if (bidVolume === 0 && askVolume === 0) {
      return 0;
    }

    const denominator = askVolume === 0 ? 1e-9 : askVolume;
    const ratio = bidVolume / denominator;

    if (!Number.isFinite(ratio)) {
      return 0;
    }

    return ratio;
  }

  private async getOrderBook(instrumentName: string): Promise<OrderBookResponse | null> {
    try {
      const response = await this.makeRequest<{ result: OrderBookResponse }>(
        '/public/get_order_book',
        {
          instrument_name: instrumentName,
          depth: 50,
        }
      );
      return response.result;
    } catch (error) {
      logger.error(`Failed to fetch order book for ${instrumentName}`, error);
      return null;
    }
  }

  private async getTicker(instrumentName: string): Promise<{ greeks?: { delta: number } } | null> {
    try {
      const response = await this.makeRequest<{ result: { greeks?: { delta: number } } }>(
        '/public/ticker',
        {
          instrument_name: instrumentName,
        }
      );
      return response.result;
    } catch (error) {
      logger.error(`Failed to fetch ticker for ${instrumentName}`, error);
      return null;
    }
  }

  private async makeRequest<T>(
    endpoint: string,
    params: Record<string, unknown>,
    retryCount = 0
  ): Promise<T> {
    try {
      const response: AxiosResponse<T> = await this.axiosInstance.get(endpoint, { params });
      return response.data;
    } catch (error) {
      if (retryCount < this.options.maxRetries) {
        const delay = this.options.retryDelayMs * Math.pow(2, retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.makeRequest<T>(endpoint, params, retryCount + 1);
      }
      throw error;
    }
  }

  private async runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
    if (tasks.length === 0) {
      return;
    }

    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      const promise = task().catch((error) => {
        logger.error('Concurrent task failed', error);
      });

      executing.push(promise);

      promise.finally(() => {
        const index = executing.indexOf(promise);
        if (index >= 0) {
          executing.splice(index, 1);
        }
      });

      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
  }
}
