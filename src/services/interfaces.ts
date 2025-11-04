/**
 * Service interfaces for the Crypto Data Alert System
 */

import {
  TradeData,
  OptionData,
  AlertMessage,
  CVDData,
  AlertHistory,
  OrderFlowRatioData,
  SkewRawData,
  ExpiryType,
  DeltaBucket,
  OptionType,
  TradeDataRow,
  AlertQueueRecord,
  CvdDeltaAlertPayload,
  MarketTradeStartPayload,
  CvdSlopeAlertPayload,
  QueuedAlertPayload,
} from '../types';
import { LogLevel } from '../types/config';

/**
 * Application configuration structure
 */
export interface AppConfig {
  discordWebhookUrl: string;
  databasePath: string;
  deribitApiUrl: string;
  optionDataInterval: number;
  cvdZScoreThreshold: number;
  cvdAggregationSymbol: string;
  cvdAggregationTradeSymbols: string[];
  cvdAggregationBatchSize: number;
  cvdAggregationPollIntervalMs: number;
  cvdAlertSuppressionMinutes: number;
  alertQueuePollIntervalMs: number;
  alertQueueBatchSize: number;
  alertQueueMaxAttempts: number;
  alertOptionPollIntervalMs: number;
  analyticsAlertIntervalMs: number;
  blockTradePollIntervalMs: number;
  blockTradeAmountThreshold: number;
  logLevel: LogLevel;
  databaseBackupEnabled: boolean;
  databaseBackupDirectory: string;
  databaseBackupIntervalMs: number;
  databaseRetentionMs: number | null;
  analyticsEnabled: boolean;
  analyticsIntervalMs: number;
  analyticsInstrumentRefreshIntervalMs: number;
  analyticsRatioWindowUsd: number;
  enableCvdAlerts: boolean;
  enableSkewChartReporter: boolean;
  marketTradeShortWindowMinutes: number;
  marketTradeShortQuantile: number;
  marketTradeShortMinSamples: number;
  marketTradeZScoreWindowMinutes: number;
  marketTradeZScoreThreshold: number;
  marketTradeZScoreMinSamples: number;
  marketTradeLinkMinutes: number;
  cvdSlopeThreshold: number;
  cvdSlopeEmaAlpha: number;
  cvdSlopeWindowHours: number;
}

export interface ProcessingState {
  lastRowId: number;
  lastTimestamp: number;
}

/**
 * Interface for data collection services
 */
export interface IDataCollector {
  /**
   * Start collecting trade data from Deribit WebSocket API
   */
  startTradeDataCollection(): Promise<void>;
  
  /**
   * Start collecting option data from Deribit REST API
   */
  startOptionDataCollection(): Promise<void>;
  
  /**
   * Stop all data collection processes
   */
  stopCollection(): Promise<void>;
}

/**
 * Interface for alert management services
 */
export interface IAlertManager {
  /**
   * Check C-P Delta 25 moving average conditions and send alerts
   */
  checkCPDelta25Alert(optionData: OptionData[]): Promise<void>;

  /**
   * Send alert message to Discord webhook
   */
  sendDiscordAlert(message: AlertMessage): Promise<void>;

  /**
   * Send alert for large block trades
   */
  sendBlockTradeAlert(trade: TradeData): Promise<void>;

  /**
   * Send chart image or other attachments to Discord
   */
  sendDiscordImage(options: { buffer: Buffer; filename: string; content?: string }): Promise<void>;

  /**
   * Dispatch formatted CVD alert payload
   */
  sendCvdAlertPayload(payload: CvdDeltaAlertPayload): Promise<void>;

  /**
   * Dispatch market trade start alert payload
   */
  sendMarketTradeStartAlert(payload: MarketTradeStartPayload): Promise<void>;

  /**
   * Dispatch CVD slope alert payload
   */
  sendCvdSlopeAlert(payload: CvdSlopeAlertPayload): Promise<void>;
}

/**
 * Interface for database management services
 */
export interface IDatabaseManager {
  /**
   * Initialize database schema and tables
   */
  initializeDatabase(): Promise<void>;
  
  /**
   * Save trade data to database
   */
  saveTradeData(data: TradeData[]): Promise<void>;
  
  /**
   * Save option data to database
   */
  saveOptionData(data: OptionData[]): Promise<void>;
  
  /**
   * Get trade data from the last 24 hours
   */
  getTradeDataLast24Hours(): Promise<TradeData[]>;
  
  /**
   * Get the latest option data
   */
  getLatestOptionData(): Promise<OptionData[]>;
  
  /**
   * Save CVD calculation results
   */
  saveCVDData(data: CVDData): Promise<void>;

  /**
   * Retrieve raw trades since specific row id
   */
  getTradeDataSinceRowId(lastRowId: number, limit: number): Promise<TradeDataRow[]>;

  /**
   * Get latest trade cursor (rowId / timestamp)
   */
  getLatestTradeCursor(symbol?: string): Promise<{ rowId: number; timestamp: number } | null>;

  /**
   * Retrieve candidate large trades since specific row id
   */
  getLargeTradeDataSinceRowId(lastRowId: number, limit: number, minAmount: number): Promise<TradeDataRow[]>;
  
  /**
   * Get CVD data for last 24 hours (5分バケット互換API)
   */
  getCVDDataLast24Hours(symbol: string): Promise<CVDData[]>;

  /**
   * Get CVD delta data from a specific timestamp for a bucket
   */
  getCvdDataSince(symbol: string, bucketSpanMinutes: number, since: number): Promise<CVDData[]>;

  /**
   * Save alert history entry
   */
  saveAlertHistory(alert: AlertHistory): Promise<void>;

  /**
   * Get recent alerts for cooldown checks
   */
  getRecentAlerts(alertType: string, minutes?: number): Promise<AlertHistory[]>;

  /**
   * Save calculated order flow ratio values
   */
  saveOrderFlowRatioData(data: OrderFlowRatioData[]): Promise<void>;

  /**
   * Save raw skew data points
   */
  saveSkewRawData(data: SkewRawData[]): Promise<void>;

  /**
   * Retrieve order flow ratio series
   */
  getOrderFlowRatioSeries(params: {
    expiryType: ExpiryType;
    deltaBucket: DeltaBucket;
    optionType: OptionType;
    since?: number;
    limit?: number;
  }): Promise<OrderFlowRatioData[]>;

  /**
   * Retrieve skew raw data series
   */
  getSkewRawSeries(params: {
    expiryType: ExpiryType;
    deltaBucket: DeltaBucket;
    optionType: OptionType;
    since?: number;
    limit?: number;
  }): Promise<SkewRawData[]>;

  /**
   * Load persisted processing cursor
   */
  getProcessingState(processName: string, key: string): Promise<ProcessingState | null>;

  /**
   * Persist processing cursor
   */
  saveProcessingState(processName: string, key: string, state: ProcessingState): Promise<void>;

  /**
   * Enqueue alert payload for asynchronous delivery
   */
  enqueueAlert(alertType: string, payload: QueuedAlertPayload, timestamp: number): Promise<number>;

  /**
   * Load pending alert queue records
   */
  getPendingAlerts(limit: number): Promise<AlertQueueRecord[]>;

  /**
   * Mark alert queue record delivered
   */
  markAlertProcessed(id: number): Promise<void>;

  /**
   * Mark alert queue record failed (retryable)
   */
  markAlertFailed(id: number, error: Error): Promise<void>;

  /**
   * Check recent alerts or pending queue entries for suppression logic
   */
  hasRecentAlertOrPending(alertType: string, cutoffTimestamp: number): Promise<boolean>;

  /**
   * Remove records older than the specified cutoff
   */
  pruneOlderThan(cutoffTimestamp: number): Promise<void>;

  /**
   * Close database connection
   */
  closeDatabase(): Promise<void>;
}

/**
 * Interface for configuration management
 */
export interface IConfigManager {
  /**
   * Load and validate configuration from environment variables
   */
  loadConfig(): Promise<void>;
  
  /**
   * Get current configuration
   */
  getConfig(): AppConfig;
  
  /**
   * Validate configuration values
   */
  validateConfig(config: Partial<AppConfig>): boolean;
}
