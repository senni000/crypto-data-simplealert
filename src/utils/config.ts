/**
 * Configuration management module
 * Handles loading and validation of environment variables
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import { AppConfig, IConfigManager } from '../services/interfaces';
import { LogLevel } from '../types/config';

// Load environment variables from .env file
dotenv.config();

/**
 * Configuration manager implementation
 */
export class ConfigManager implements IConfigManager {
  private config: AppConfig | null = null;

  /**
   * Load and validate configuration from environment variables
   */
  async loadConfig(): Promise<void> {
    const backupEnabled = this.getBooleanEnvVar('DATABASE_BACKUP_ENABLED', false);
    const backupDirectoryRaw = this.getEnvVar(
      'DATABASE_BACKUP_PATH',
      '/Volumes/buffalohd/crypto-data/backups/deribit'
    );
    const backupIntervalMs = this.getNumberEnvVar('DATABASE_BACKUP_INTERVAL_MS', 24 * 60 * 60 * 1000);
    const retentionDays = this.getNumberEnvVar('DATABASE_RETENTION_DAYS', 3);
    const databaseRetentionMs =
      retentionDays > 0 ? Math.floor(retentionDays * 24 * 60 * 60 * 1000) : null;
    const analyticsEnabled = this.getBooleanEnvVar('ENABLE_ANALYTICS_COLLECTION', true);
    const enableCvdAlerts = this.getBooleanEnvVar('ENABLE_CVD_ALERTS', true);
    const analyticsInterval = this.getNumberEnvVar('ANALYTICS_INTERVAL_MS', 60000);
    const analyticsRefreshInterval = this.getNumberEnvVar('ANALYTICS_REFRESH_INTERVAL_MS', 3600000);
    const analyticsRatioWindowUsd = this.getNumberEnvVar('ANALYTICS_RATIO_WINDOW_USD', 5);
    const optionDataInterval = this.getNumberEnvVar('OPTION_DATA_INTERVAL', 3600000);
    const cvdAggregationSymbol = this.getEnvVar('CVD_AGGREGATION_SYMBOL', 'BTC-PERP');
    const cvdAggregationTradeSymbolsRaw = this.getEnvVar(
      'CVD_AGGREGATION_TRADE_SYMBOLS',
      'BTC-PERPETUAL,BTC-PERPETUAL-USDC'
    );
    const cvdAggregationTradeSymbols = this.parseSymbolList(cvdAggregationTradeSymbolsRaw);
    const cvdAggregationBatchSize = this.getNumberEnvVar('CVD_AGGREGATION_BATCH_SIZE', 500);
    const cvdAggregationPollIntervalMs = this.getNumberEnvVar('CVD_AGGREGATION_POLL_INTERVAL_MS', 2000);
    const cvdAlertSuppressionMinutes = this.getNumberEnvVar('CVD_ALERT_SUPPRESSION_MINUTES', 30);
    const alertQueuePollIntervalMs = this.getNumberEnvVar('ALERT_QUEUE_POLL_INTERVAL_MS', 5000);
    const alertQueueBatchSize = this.getNumberEnvVar('ALERT_QUEUE_BATCH_SIZE', 50);
    const alertQueueMaxAttempts = this.getNumberEnvVar('ALERT_QUEUE_MAX_ATTEMPTS', 5);
    const alertOptionPollIntervalMs = this.getNumberEnvVar('ALERT_OPTION_POLL_INTERVAL_MS', optionDataInterval);
    const analyticsAlertIntervalMs = this.getNumberEnvVar('ANALYTICS_ALERT_INTERVAL_MS', analyticsInterval);
    const blockTradePollIntervalMs = this.getNumberEnvVar('BLOCK_TRADE_POLL_INTERVAL_MS', 10000);
    const blockTradeAmountThreshold = this.getNumberEnvVar('BLOCK_TRADE_AMOUNT_THRESHOLD', 1000);

    const config: AppConfig = {
      discordWebhookUrl: this.getRequiredEnvVar('DISCORD_WEBHOOK_URL'),
      databasePath: this.expandPath(this.getEnvVar('DATABASE_PATH', '~/workspace/crypto-data/data/deribit.db')),
      deribitApiUrl: this.getEnvVar('DERIBIT_API_URL', 'wss://www.deribit.com/ws/api/v2'),
      optionDataInterval,
      cvdZScoreThreshold: this.getNumberEnvVar('CVD_ZSCORE_THRESHOLD', 2.0),
      cvdAggregationSymbol,
      cvdAggregationTradeSymbols,
      cvdAggregationBatchSize,
      cvdAggregationPollIntervalMs,
      cvdAlertSuppressionMinutes,
      alertQueuePollIntervalMs,
      alertQueueBatchSize,
      alertQueueMaxAttempts,
      alertOptionPollIntervalMs,
      analyticsAlertIntervalMs,
      blockTradePollIntervalMs,
      blockTradeAmountThreshold,
      logLevel: this.getLogLevel(this.getEnvVar('LOG_LEVEL', 'info') as LogLevel),
      databaseBackupEnabled: backupEnabled,
      databaseBackupDirectory: this.expandPath(backupDirectoryRaw),
      databaseBackupIntervalMs: backupIntervalMs,
      databaseRetentionMs,
      analyticsEnabled,
      enableCvdAlerts,
      analyticsIntervalMs: analyticsInterval,
      analyticsInstrumentRefreshIntervalMs: analyticsRefreshInterval,
      analyticsRatioWindowUsd: analyticsRatioWindowUsd,
    };

    if (!this.validateConfig(config)) {
      throw new Error('Configuration validation failed');
    }

    this.config = config;
  }

  /**
   * Get current configuration
   */
  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call loadConfig() first.');
    }
    return this.config;
  }

  /**
   * Validate configuration values
   */
  validateConfig(config: Partial<AppConfig>): boolean {
    const errors: string[] = [];

    // Validate Discord Webhook URL
    if (!config.discordWebhookUrl) {
      errors.push('DISCORD_WEBHOOK_URL is required');
    } else if (!this.isValidWebhookUrl(config.discordWebhookUrl)) {
      errors.push('DISCORD_WEBHOOK_URL must be a valid Discord webhook URL');
    }

    // Validate database path
    if (!config.databasePath) {
      errors.push('DATABASE_PATH is required');
    }

    // Validate Deribit API URL
    if (!config.deribitApiUrl) {
      errors.push('DERIBIT_API_URL is required');
    } else if (!this.isValidWebSocketUrl(config.deribitApiUrl)) {
      errors.push('DERIBIT_API_URL must be a valid WebSocket URL');
    }

    // Validate option data interval
    if (config.optionDataInterval !== undefined) {
      if (config.optionDataInterval < 60000) { // Minimum 1 minute
        errors.push('OPTION_DATA_INTERVAL must be at least 60000ms (1 minute)');
      }
      if (config.optionDataInterval > 86400000) { // Maximum 24 hours
        errors.push('OPTION_DATA_INTERVAL must be at most 86400000ms (24 hours)');
      }
    }

    if (config.analyticsIntervalMs !== undefined) {
      if (config.analyticsIntervalMs < 10000) {
        errors.push('ANALYTICS_INTERVAL_MS must be at least 10000ms (10 seconds)');
      }
      if (config.analyticsIntervalMs > 3600000) {
        errors.push('ANALYTICS_INTERVAL_MS must be at most 3600000ms (1 hour)');
      }
    }

    if (config.analyticsInstrumentRefreshIntervalMs !== undefined) {
      if (config.analyticsInstrumentRefreshIntervalMs < 600000) {
        errors.push('ANALYTICS_REFRESH_INTERVAL_MS must be at least 600000ms (10 minutes)');
      }
    }

    if (config.analyticsRatioWindowUsd !== undefined && config.analyticsRatioWindowUsd <= 0) {
      errors.push('ANALYTICS_RATIO_WINDOW_USD must be greater than 0');
    }

    if (config.analyticsAlertIntervalMs !== undefined && config.analyticsAlertIntervalMs < 5000) {
      errors.push('ANALYTICS_ALERT_INTERVAL_MS must be at least 5000ms (5 seconds)');
    }

    if (config.alertQueuePollIntervalMs !== undefined && config.alertQueuePollIntervalMs < 1000) {
      errors.push('ALERT_QUEUE_POLL_INTERVAL_MS must be at least 1000ms (1 second)');
    }

    if (config.alertQueueBatchSize !== undefined && config.alertQueueBatchSize <= 0) {
      errors.push('ALERT_QUEUE_BATCH_SIZE must be greater than 0');
    }

    if (config.alertQueueMaxAttempts !== undefined && config.alertQueueMaxAttempts <= 0) {
      errors.push('ALERT_QUEUE_MAX_ATTEMPTS must be greater than 0');
    }

    if (config.cvdAggregationBatchSize !== undefined && config.cvdAggregationBatchSize <= 0) {
      errors.push('CVD_AGGREGATION_BATCH_SIZE must be greater than 0');
    }

    if (config.cvdAggregationPollIntervalMs !== undefined && config.cvdAggregationPollIntervalMs < 500) {
      errors.push('CVD_AGGREGATION_POLL_INTERVAL_MS must be at least 500ms');
    }

    if (config.cvdAlertSuppressionMinutes !== undefined && config.cvdAlertSuppressionMinutes < 0) {
      errors.push('CVD_ALERT_SUPPRESSION_MINUTES must be zero or positive');
    }

    if (config.alertOptionPollIntervalMs !== undefined && config.alertOptionPollIntervalMs < 1000) {
      errors.push('ALERT_OPTION_POLL_INTERVAL_MS must be at least 1000ms (1 second)');
    }

    if (config.blockTradePollIntervalMs !== undefined && config.blockTradePollIntervalMs < 1000) {
      errors.push('BLOCK_TRADE_POLL_INTERVAL_MS must be at least 1000ms (1 second)');
    }

    if (config.blockTradeAmountThreshold !== undefined && config.blockTradeAmountThreshold <= 0) {
      errors.push('BLOCK_TRADE_AMOUNT_THRESHOLD must be greater than 0');
    }

    if (config.cvdAggregationSymbol !== undefined && !config.cvdAggregationSymbol.trim()) {
      errors.push('CVD_AGGREGATION_SYMBOL must not be empty');
    }

    if (config.cvdAggregationTradeSymbols !== undefined) {
      if (
        !Array.isArray(config.cvdAggregationTradeSymbols) ||
        config.cvdAggregationTradeSymbols.length === 0
      ) {
        errors.push('CVD_AGGREGATION_TRADE_SYMBOLS must contain at least one symbol');
      } else if (config.cvdAggregationTradeSymbols.some((symbol) => !symbol.trim())) {
        errors.push('CVD_AGGREGATION_TRADE_SYMBOLS must not contain empty entries');
      }
    }

    // Validate CVD Z-Score threshold
    if (config.cvdZScoreThreshold !== undefined) {
      if (config.cvdZScoreThreshold < 0.1) {
        errors.push('CVD_ZSCORE_THRESHOLD must be at least 0.1');
      }
      if (config.cvdZScoreThreshold > 10) {
        errors.push('CVD_ZSCORE_THRESHOLD must be at most 10');
      }
    }

    // Validate log level
    if (config.logLevel && !this.isValidLogLevel(config.logLevel)) {
      errors.push('LOG_LEVEL must be one of error, warn, info, debug');
    }

    if (config.databaseBackupEnabled) {
      if (!config.databaseBackupDirectory) {
        errors.push('DATABASE_BACKUP_PATH is required when DATABASE_BACKUP_ENABLED is true');
      }
      if (
        config.databaseBackupIntervalMs !== undefined &&
        config.databaseBackupIntervalMs < 60000
      ) {
        errors.push('DATABASE_BACKUP_INTERVAL_MS must be at least 60000ms (1 minute)');
      }
    }

    if (errors.length > 0) {
      console.error('Configuration validation errors:');
      errors.forEach(error => console.error(`  - ${error}`));
      return false;
    }

    return true;
  }

  private parseSymbolList(value: string): string[] {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => item.toUpperCase());
  }

  /**
   * Get required environment variable
   */
  private getRequiredEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Required environment variable ${name} is not set`);
    }
    return value;
  }

  /**
   * Get optional environment variable with default value
   */
  private getEnvVar(name: string, defaultValue: string): string {
    return process.env[name] || defaultValue;
  }

  /**
   * Get boolean environment variable with default value
   */
  private getBooleanEnvVar(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (value === undefined) {
      return defaultValue;
    }

    switch (value.toLowerCase()) {
      case '1':
      case 'true':
      case 'yes':
      case 'on':
        return true;
      case '0':
      case 'false':
      case 'no':
      case 'off':
        return false;
      default:
        console.warn(`Invalid boolean value for ${name}: ${value}. Using default: ${defaultValue}`);
        return defaultValue;
    }
  }

  /**
   * Get numeric environment variable with default value
   */
  private getNumberEnvVar(name: string, defaultValue: number): number {
    const value = process.env[name];
    if (value === undefined || value === '') {
      return defaultValue;
    }

    const numValue = Number(value);
    if (isNaN(numValue)) {
      console.warn(`Invalid numeric value for ${name}: ${value}. Using default: ${defaultValue}`);
      return defaultValue;
    }

    return numValue;
  }

  /**
   * Normalize log level value
   */
  private getLogLevel(value: LogLevel): LogLevel {
    if (this.isValidLogLevel(value)) {
      return value;
    }
    console.warn(`Invalid LOG_LEVEL: ${value}. Falling back to info.`);
    return 'info';
  }

  /**
   * Check if log level is valid
   */
  private isValidLogLevel(value: string): value is LogLevel {
    return ['error', 'warn', 'info', 'debug'].includes(value);
  }

  /**
   * Expand tilde (~) in file paths to home directory
   */
  private expandPath(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  /**
   * Validate Discord webhook URL format
   */
  private isValidWebhookUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname === 'discord.com' || urlObj.hostname === 'discordapp.com';
    } catch {
      return false;
    }
  }

  /**
   * Validate WebSocket URL format
   */
  private isValidWebSocketUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'ws:' || urlObj.protocol === 'wss:';
    } catch {
      return false;
    }
  }
}

/**
 * Global configuration manager instance
 */
export const configManager = new ConfigManager();

/**
 * Utility function to get configuration
 */
export function getConfig(): AppConfig {
  return configManager.getConfig();
}

/**
 * Utility function to initialize configuration
 */
export async function initializeConfig(): Promise<void> {
  await configManager.loadConfig();
}
