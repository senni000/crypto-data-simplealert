/**
 * Alert Manager
 * Handles alert condition checks and Discord webhook notifications
 */

import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import { OptionData, TradeData, AlertMessage, CVDData } from '../types';
import { IAlertManager, IDatabaseManager } from './interfaces';
import {
  CPDelta25Calculator,
  MovingAverageMonitor,
  CVDMonitor,
  CVDCalculator,
  ZScoreCalculator,
} from './calculation-engine';
import { AlertHistory } from '../types';
import { logger } from '../utils/logger';

export interface HttpClient {
  post(url: string, data?: unknown, config?: unknown): Promise<AxiosResponse<any>>;
}

export interface AlertManagerOptions {
  webhookUrl: string;
  maxRetries?: number;
  retryDelayMs?: number;
  cvdThreshold?: number;
  cvdCooldownMinutes?: number;
  cpPeriod?: number;
  cpChangeThreshold?: number;
  cpCooldownMinutes?: number;
  httpClient?: HttpClient;
}

export interface DiscordEmbedOptions {
  title: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  imageUrl?: string;
  footer?: string;
  content?: string;
}

/**
 * Main alert manager implementation
 */
export class AlertManager extends EventEmitter implements IAlertManager {
  private readonly webhookUrl: string;
  private readonly databaseManager: IDatabaseManager;
  private readonly httpClient: HttpClient;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly cvdMonitor: CVDMonitor;
  private readonly movingAverageMonitor: MovingAverageMonitor;
  private readonly cvdCooldownMinutes: number;
  private readonly cpCooldownMinutes: number;

  constructor(databaseManager: IDatabaseManager, options: AlertManagerOptions) {
    super();

    this.databaseManager = databaseManager;
    this.webhookUrl = options.webhookUrl;
    this.httpClient = options.httpClient ?? axios;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;

    const cvdThreshold = options.cvdThreshold ?? 2.0;
    this.cvdCooldownMinutes = options.cvdCooldownMinutes ?? 30;
    const cvdCooldown = this.cvdCooldownMinutes;
    this.cvdMonitor = new CVDMonitor(cvdThreshold, cvdCooldown);

    const cpPeriod = options.cpPeriod ?? 10;
    const cpChangeThreshold = options.cpChangeThreshold ?? 0.05;
    this.cpCooldownMinutes = options.cpCooldownMinutes ?? 15;
    const cpCooldown = this.cpCooldownMinutes;
    this.movingAverageMonitor = new MovingAverageMonitor(cpPeriod, cpChangeThreshold, cpCooldown);
  }

  /**
   * Check C-P Delta 25 moving average conditions and send alerts if needed
   */
  async checkCPDelta25Alert(optionData: OptionData[]): Promise<void> {
    if (!optionData || optionData.length === 0) {
      return;
    }

    const deltaResult = CPDelta25Calculator.calculateCPDelta25(optionData);
    if (!deltaResult.call || !deltaResult.put) {
      return;
    }

    const timestamp = Date.now();
    const monitorResult = this.movingAverageMonitor.addValue(deltaResult.cpDelta, timestamp);

    if (!monitorResult.shouldAlert) {
      return;
    }

    const change = monitorResult.currentMA - monitorResult.previousMA;
    const changeRate = monitorResult.previousMA === 0 ? 0 : change / monitorResult.previousMA;

    // Prevent duplicate alerts within cooldown window persisted in DB
    if (await this.hasRecentAlert('CP_DELTA_25', this.cpCooldownMinutes)) {
      return;
    }

    const message: AlertMessage = {
      type: 'CP_DELTA_25',
      timestamp,
      value: monitorResult.currentMA,
      threshold: this.movingAverageMonitor.getChangeThreshold(),
      message: this.buildCPDeltaMessage(
        monitorResult.currentMA,
        change,
        changeRate,
        deltaResult.call.symbol,
        deltaResult.put.symbol
      ),
    };

    await this.sendDiscordAlert(message);
    this.emit('cpDeltaAlert', message);
  }

  /**
   * Check CVD Z-score conditions and send alerts if needed
   */
  async checkCVDAlert(tradeData: TradeData[]): Promise<void> {
    if (!tradeData || tradeData.length === 0) {
      return;
    }

    const timestamp = Date.now();
    const historicalCVD = await this.databaseManager.getCVDDataLast24Hours();
    const lastEntry = historicalCVD.length > 0 ? historicalCVD[historicalCVD.length - 1] : undefined;
    const lastCVD = lastEntry ? lastEntry.cvdValue : 0;

    const incrementalCVD = CVDCalculator.calculateBTCPerpetualCVD(tradeData);
    const currentCVD = lastCVD + incrementalCVD;

    const zScore = ZScoreCalculator.calculateCVDZScore(currentCVD, historicalCVD);

    const cvdRecord: CVDData = {
      timestamp,
      cvdValue: currentCVD,
      zScore,
    };

    await this.databaseManager.saveCVDData(cvdRecord);

    const shouldAlert = this.cvdMonitor.checkZScoreThreshold(zScore, timestamp);
    if (!shouldAlert) {
      return;
    }

    if (await this.hasRecentAlert('CVD_ZSCORE', this.cvdCooldownMinutes)) {
      return;
    }

    const message: AlertMessage = {
      type: 'CVD_ZSCORE',
      timestamp,
      value: zScore,
      threshold: this.cvdMonitor.getThreshold(),
      message: this.buildCVDMessage(zScore, currentCVD),
    };

    await this.sendDiscordAlert(message);
    this.emit('cvdAlert', message);
  }

  /**
   * Send alert message to Discord webhook with retry logic
   */
  async sendDiscordAlert(message: AlertMessage): Promise<void> {
    const payload = {
      content: this.formatDiscordContent(message),
    };

    try {
      await this.postToDiscord(payload, {
        errorContext: 'Failed to send alert to Discord',
        onSuccess: async () => {
          await this.databaseManager.saveAlertHistory({
            alertType: message.type,
            timestamp: message.timestamp,
            value: message.value,
            threshold: message.threshold,
            message: message.message,
          });

          this.emit('alertSent', message);
        },
      });
    } catch (error) {
      this.emit('alertFailed', error, message);
      throw error;
    }
  }

  /**
   * Send generic embed payload to Discord
   */
  async sendDiscordEmbed(options: DiscordEmbedOptions): Promise<void> {
    const embed: {
      title: string;
      timestamp: string;
      description?: string;
      fields?: Array<{ name: string; value: string; inline?: boolean }>;
      image?: { url: string };
      footer?: { text: string };
    } = {
      title: options.title,
      timestamp: new Date().toISOString(),
    };

    if (options.description) {
      embed.description = options.description;
    }

    if (options.fields && options.fields.length > 0) {
      embed.fields = options.fields;
    }

    if (options.imageUrl) {
      embed.image = { url: options.imageUrl };
    }

    if (options.footer) {
      embed.footer = { text: options.footer };
    }

    const payload: {
      embeds: typeof embed[];
      content?: string;
    } = {
      embeds: [embed],
    };

    if (options.content) {
      payload.content = options.content;
    }

    await this.postToDiscord(payload, {
      errorContext: 'Failed to send embed to Discord',
    });
  }

  /**
   * Notify Discord when a large block trade is detected
   */
  async sendBlockTradeAlert(trade: TradeData): Promise<void> {
    const amountFormatted = this.formatNumber(trade.amount, {
      maximumFractionDigits: 4,
    });
    const priceFormatted = this.formatNumber(trade.price, {
      minimumFractionDigits: 2,
    });

    const fields: DiscordEmbedOptions['fields'] = [
      { name: '銘柄', value: trade.symbol, inline: false },
      { name: '方向', value: trade.direction === 'buy' ? '買い' : '売り', inline: true },
      { name: '数量', value: amountFormatted, inline: true },
      { name: '約定価格', value: priceFormatted, inline: true },
    ];

    if (typeof trade.markPrice === 'number') {
      fields.push({
        name: 'マーク価格',
        value: this.formatNumber(trade.markPrice, { minimumFractionDigits: 2 }),
        inline: true,
      });
    }

    if (typeof trade.indexPrice === 'number') {
      fields.push({
        name: 'インデックス価格',
        value: this.formatNumber(trade.indexPrice, { minimumFractionDigits: 2 }),
        inline: true,
      });
    }

    const footerParts = [
      `Trade ID: ${trade.tradeId}`,
      `Channel: ${trade.channel ?? 'N/A'}`,
      `Timestamp: ${new Date(trade.timestamp).toISOString()}`,
    ];

    await this.sendDiscordEmbed({
      title: '🚨 大口ブロックトレード検知',
      description: '数量が1,000を超えるBTCブロックトレードを検出しました。',
      fields,
      footer: footerParts.join(' | '),
      content: '🚨 **ブロックトレード警報**',
    });
  }

  /**
   * Helper to check recent alerts stored in the database
   */
  private async hasRecentAlert(alertType: string, minutes: number): Promise<boolean> {
    try {
      const alerts: AlertHistory[] = await this.databaseManager.getRecentAlerts(alertType, minutes);
      return alerts.length > 0;
    } catch (error) {
      logger.error('Failed to check recent alerts', error);
      return false;
    }
  }

  /**
   * Build Discord message content for CP Delta alerts
   */
  private buildCPDeltaMessage(
    currentMA: number,
    change: number,
    changeRate: number,
    callSymbol: string,
    putSymbol: string
  ): string {
    const direction = change >= 0 ? '上昇' : '下落';
    const percentage = (Math.abs(changeRate) * 100).toFixed(2);
    return [
      `C-P Δ25移動平均が${direction}しました。`,
      `現行MA: ${currentMA.toFixed(4)}`,
      `変化量: ${change.toFixed(4)} (${percentage}%)`,
      `対象コール: ${callSymbol}`,
      `対象プット: ${putSymbol}`,
    ].join(' | ');
  }

  /**
   * Build Discord message content for CVD alerts
   */
  private buildCVDMessage(zScore: number, currentCVD: number): string {
    const direction = zScore >= 0 ? '正' : '負';
    return [
      `CVD Z-Scoreが閾値を超過しました (${direction}).`,
      `Z-Score: ${zScore.toFixed(2)}`,
      `CVD値: ${currentCVD.toFixed(2)}`,
    ].join(' | ');
  }

  /**
   * Format final Discord payload content
   */
  private formatDiscordContent(message: AlertMessage): string {
    const timestamp = new Date(message.timestamp).toISOString();
    return [
      `**${message.type} アラート**`,
      message.message,
      `値: ${message.value.toFixed(4)} / 閾値: ${message.threshold.toFixed(4)}`,
      `時刻: ${timestamp}`,
    ].join('\n');
  }

  /**
   * Post payload to Discord webhook with retry logic
   */
  private async postToDiscord(
    payload: Record<string, unknown>,
    options?: { onSuccess?: () => Promise<void>; errorContext?: string }
  ): Promise<void> {
    if (!this.webhookUrl) {
      logger.warn('Discord webhook URL is not configured.');
      return;
    }

    const webhookUrl = this.ensureWaitQuery(this.webhookUrl);
    const errorContext = options?.errorContext ?? 'Failed to send payload to Discord';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.httpClient.post(webhookUrl, payload);
        const status = 'status' in response ? response.status : undefined;
        logger.debug('Discord webhook responded', { status });

        if (options?.onSuccess) {
          await options.onSuccess();
        }

        return;
      } catch (error) {
        const isLastAttempt = attempt === this.maxRetries;
        logger.error(errorContext, error);

        if (isLastAttempt) {
          throw error;
        }

        const delay = this.retryDelayMs * Math.pow(2, attempt);
        await this.sleep(delay);
      }
    }
  }

  /**
   * Ensure Discord webhook URL requests response payload
   */
  private ensureWaitQuery(url: string): string {
    if (url.includes('wait=')) {
      return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}wait=true`;
  }

  /**
   * Format numbers for human-readable output
   */
  private formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 4,
      minimumFractionDigits: 0,
      ...options,
    }).format(value);
  }

  /**
   * Sleep helper used for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
