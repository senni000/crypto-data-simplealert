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
  logLevel: LogLevel;
  databaseBackupEnabled: boolean;
  databaseBackupPath: string;
  databaseBackupInterval: number;
  databaseBackupRetentionDays: number;
  analyticsEnabled: boolean;
  analyticsIntervalMs: number;
  analyticsInstrumentRefreshIntervalMs: number;
  analyticsRatioWindowUsd: number;
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
   * Check CVD Z-score conditions and send alerts
   */
  checkCVDAlert(tradeData: TradeData[]): Promise<void>;
  
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
   * Get CVD data for Z-score calculation
   */
  getCVDDataLast24Hours(): Promise<CVDData[]>;

  /**
   * Get CVD data from a specific timestamp
   */
  getCVDDataSince(since: number): Promise<CVDData[]>;

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
