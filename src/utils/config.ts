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
    const backupPathRaw = this.getEnvVar('DATABASE_BACKUP_PATH', '/Volumes/buffalohd/crypto_data.db');
    const backupInterval = this.getNumberEnvVar('DATABASE_BACKUP_INTERVAL', 3600000);
    const backupRetentionDays = this.getNumberEnvVar('DATABASE_BACKUP_RETENTION_DAYS', 7);

    const config: AppConfig = {
      discordWebhookUrl: this.getRequiredEnvVar('DISCORD_WEBHOOK_URL'),
      databasePath: this.expandPath(this.getEnvVar('DATABASE_PATH', '~/workspace/crypto-data/data/crypto_data.db')),
      deribitApiUrl: this.getEnvVar('DERIBIT_API_URL', 'wss://www.deribit.com/ws/api/v2'),
      optionDataInterval: this.getNumberEnvVar('OPTION_DATA_INTERVAL', 3600000),
      cvdZScoreThreshold: this.getNumberEnvVar('CVD_ZSCORE_THRESHOLD', 2.0),
      logLevel: this.getLogLevel(this.getEnvVar('LOG_LEVEL', 'info') as LogLevel),
      databaseBackupEnabled: backupEnabled,
      databaseBackupPath: this.expandPath(backupPathRaw),
      databaseBackupInterval: backupInterval,
      databaseBackupRetentionDays: backupRetentionDays,
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
      if (!config.databaseBackupPath) {
        errors.push('DATABASE_BACKUP_PATH is required when DATABASE_BACKUP_ENABLED is true');
      }

      if (config.databaseBackupInterval !== undefined && config.databaseBackupInterval < 60000) {
        errors.push('DATABASE_BACKUP_INTERVAL must be at least 60000ms (1 minute)');
      }

      if (config.databaseBackupRetentionDays !== undefined && config.databaseBackupRetentionDays < 0) {
        errors.push('DATABASE_BACKUP_RETENTION_DAYS must be greater than or equal to 0');
      }
    }

    if (errors.length > 0) {
      console.error('Configuration validation errors:');
      errors.forEach(error => console.error(`  - ${error}`));
      return false;
    }

    return true;
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
