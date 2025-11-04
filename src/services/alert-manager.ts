/**
 * Alert Manager
 * Handles alert condition checks and Discord webhook notifications
 */

import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import FormData from 'form-data';
import {
  OptionData,
  TradeData,
  AlertMessage,
  CvdDeltaAlertPayload,
  MarketTradeStartPayload,
  CvdSlopeAlertPayload,
} from '../types';
import { IAlertManager, IDatabaseManager } from './interfaces';
import { CPDelta25Calculator, MovingAverageMonitor } from './calculation-engine';
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
  enableCvdSlopeDiscord?: boolean;
  enableCvdDelta5mDiscord?: boolean;
}

export interface DiscordEmbedOptions {
  title: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  imageUrl?: string;
  footer?: string;
  content?: string;
}

export interface DiscordImageOptions {
  buffer: Buffer;
  filename: string;
  content?: string;
}

const CVD_ALERT_EMOJI = '🟠';
const JST_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Main alert manager implementation
 */
export class AlertManager extends EventEmitter implements IAlertManager {
  private readonly webhookUrl: string;
  private readonly databaseManager: IDatabaseManager;
  private readonly httpClient: HttpClient;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly movingAverageMonitor: MovingAverageMonitor;
  private readonly cvdCooldownMinutes: number;
  private readonly cpCooldownMinutes: number;
  private readonly enableCvdSlopeDiscord: boolean;
  private readonly enableCvdDelta5mDiscord: boolean;

  constructor(databaseManager: IDatabaseManager, options: AlertManagerOptions) {
    super();

    this.databaseManager = databaseManager;
    this.webhookUrl = options.webhookUrl;
    this.httpClient = options.httpClient ?? axios;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;

    this.cvdCooldownMinutes = options.cvdCooldownMinutes ?? 30;
    const cpPeriod = options.cpPeriod ?? 10;
    const cpChangeThreshold = options.cpChangeThreshold ?? 0.05;
    this.cpCooldownMinutes = options.cpCooldownMinutes ?? 15;
    const cpCooldown = this.cpCooldownMinutes;
    this.movingAverageMonitor = new MovingAverageMonitor(cpPeriod, cpChangeThreshold, cpCooldown);

    this.enableCvdSlopeDiscord = options.enableCvdSlopeDiscord ?? true;
    this.enableCvdDelta5mDiscord = options.enableCvdDelta5mDiscord ?? true;
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
   * Send image with optional message to Discord webhook
   */
  async sendDiscordImage(options: DiscordImageOptions): Promise<void> {
    const form = new FormData();
    const payload = {
      content: options.content ?? '',
      allowed_mentions: { parse: [] as string[] },
    };

    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', options.buffer, {
      filename: options.filename,
      contentType: 'image/png',
    });

    await this.postToDiscord(form, {
      errorContext: 'Failed to send image to Discord',
      headers: form.getHeaders() as Record<string, string>,
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
  private buildCVDMessage(payload: CvdDeltaAlertPayload): string {
    const directionLabel = payload.direction === 'buy' ? '買い優勢' : '売り優勢';
    const formattedDelta = Math.abs(payload.delta).toFixed(2);
    const formattedZScore = payload.zScore.toFixed(2);
    const formattedTime = JST_FORMATTER.format(new Date(payload.timestamp));
    const windowLabel = `${payload.windowHours}h`;
    const bucketLabel = `${payload.bucketSpanMinutes}分`;

    return [
      `${CVD_ALERT_EMOJI}【Deribit CVD Alert】${payload.symbol}`,
      `時間: ${formattedTime}`,
      `方向: ${directionLabel}`,
      `バケット: ${bucketLabel}`,
      `比較窓: ${windowLabel}`,
      `差分出来高: ${formattedDelta}`,
      `Zスコア: ${formattedZScore} / 閾値: ${payload.threshold.toFixed(2)}`,
    ].join('\n');
  }

  async sendCvdAlertPayload(payload: CvdDeltaAlertPayload): Promise<void> {
    const alertType = this.getCvdAlertType(payload.bucketSpanMinutes, payload.direction);
    if (await this.hasRecentAlert(alertType, this.cvdCooldownMinutes)) {
      logger.debug('Skipping CVD alert due to cooldown window');
      return;
    }

    const message: AlertMessage = {
      type: 'CVD_DELTA',
      timestamp: payload.timestamp,
      value: payload.zScore,
      threshold: payload.threshold,
      message: this.buildCVDMessage(payload),
    };

    const shouldSendDiscord = !(
      payload.bucketSpanMinutes === 5 && !this.enableCvdDelta5mDiscord
    );

    if (shouldSendDiscord) {
      await this.sendDiscordAlert(message);
    } else {
      logger.debug('CVD 5m alert Discord notification disabled; recording history only', {
        alertType,
        bucketSpanMinutes: payload.bucketSpanMinutes,
        direction: payload.direction,
      });
    }

    await this.databaseManager.saveAlertHistory({
      alertType,
      timestamp: payload.timestamp,
      value: payload.zScore,
      threshold: payload.threshold,
      message: message.message,
    });
    this.emit('cvdAlert', message);
  }

  private formatMarketTradeAmount(value: number): string {
    if (!Number.isFinite(value)) {
      return '-';
    }

    const absValue = Math.abs(value);
    let maximumFractionDigits = 2;

    if (absValue < 1) {
      if (absValue < 0.0001) {
        maximumFractionDigits = 8;
      } else if (absValue < 0.001) {
        maximumFractionDigits = 7;
      } else if (absValue < 0.01) {
        maximumFractionDigits = 6;
      } else if (absValue < 0.1) {
        maximumFractionDigits = 5;
      } else {
        maximumFractionDigits = 4;
      }
    } else if (absValue < 10) {
      maximumFractionDigits = 4;
    } else if (absValue < 100) {
      maximumFractionDigits = 3;
    }

    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits,
    });
  }

  private buildMarketTradeStartMessage(payload: MarketTradeStartPayload): string {
    const formattedTime = JST_FORMATTER.format(new Date(payload.timestamp));
    const directionLabel = payload.direction === 'buy' ? '成行買い' : '成行売り';
    const formattedAmount = `${this.formatMarketTradeAmount(payload.amount)} BTC`;
    const windowLabel = `${Math.round(payload.windowMinutes)}分`;

    const lines: Array<string | undefined> = [
      `${CVD_ALERT_EMOJI}【Deribit Trade Start】${payload.symbol}`,
      `時間: ${formattedTime}`,
      `方向: ${directionLabel}`,
      `数量: ${formattedAmount}`,
      `戦略: ${payload.strategy === 'SHORT_WINDOW_QUANTILE' ? '短期分位判定' : '対数Zスコア判定'}`,
      `窓: ${windowLabel}`,
    ];

    if (payload.strategy === 'SHORT_WINDOW_QUANTILE') {
      lines.push(
        `分位(${(payload.quantileLevel * 100).toFixed(2)}%): ${this.formatMarketTradeAmount(payload.quantile)} BTC`,
        `サンプル数: ${payload.sampleCount}`
      );
    } else {
      lines.push(
        `Zスコア: ${payload.zScore.toFixed(2)} / 閾値: ${payload.zScoreThreshold.toFixed(2)}`,
        `log平均: ${payload.logMean.toFixed(4)} / logσ: ${payload.logStdDev.toFixed(4)}`,
        `log数量: ${payload.logAmount.toFixed(4)}`,
        `サンプル数: ${payload.sampleCount}`
      );
    }

    lines.push(`Trade ID: ${payload.tradeId}`);

    return lines.filter((line): line is string => Boolean(line)).join('\n');
  }

  async sendMarketTradeStartAlert(payload: MarketTradeStartPayload): Promise<void> {
    const alertType = this.getMarketTradeStartAlertType(payload);
    if (await this.hasRecentAlert(alertType, this.cvdCooldownMinutes)) {
      logger.debug('Skipping market trade spike alert due to cooldown window');
      return;
    }

    const metricValue =
      payload.strategy === 'SHORT_WINDOW_QUANTILE' ? payload.amount : payload.zScore;
    const metricThreshold =
      payload.strategy === 'SHORT_WINDOW_QUANTILE' ? payload.threshold : payload.zScoreThreshold;

    const message: AlertMessage = {
      type: 'MARKET_TRADE_START',
      timestamp: payload.timestamp,
      value: metricValue,
      threshold: metricThreshold,
      message: this.buildMarketTradeStartMessage(payload),
    };

    await this.sendDiscordAlert(message);
    await this.databaseManager.saveAlertHistory({
      alertType,
      timestamp: payload.timestamp,
      value: metricValue,
      threshold: metricThreshold,
      message: message.message,
    });

    this.emit('cvdAlert', message);
  }

  private buildCvdSlopeMessage(payload: CvdSlopeAlertPayload): string {
    const formattedTime = JST_FORMATTER.format(new Date(payload.timestamp));
    const directionLabel = payload.direction === 'buy' ? '買い優勢' : '売り優勢';
    const deltaLabel = payload.delta.toFixed(2);
    const slopeLabel = payload.slope.toFixed(4);
    return [
      `${CVD_ALERT_EMOJI}【Deribit CVD Slope】${payload.symbol}`,
      `時間: ${formattedTime}`,
      `方向: ${directionLabel}`,
      `バケット: ${payload.bucketSpanMinutes}分`,
      `差分出来高: ${deltaLabel}`,
      `EMA傾き: ${slopeLabel}`,
      `傾きZ: ${payload.slopeZ.toFixed(2)} / 閾値: ${payload.threshold.toFixed(2)}`,
      `比較窓: ${payload.windowHours}h`,
    ].join('\n');
  }

  async sendCvdSlopeAlert(payload: CvdSlopeAlertPayload): Promise<void> {
    const alertType = this.getCvdSlopeAlertType(payload.bucketSpanMinutes, payload.direction);
    if (await this.hasRecentAlert(alertType, this.cvdCooldownMinutes)) {
      logger.debug('Skipping CVD slope alert due to cooldown window');
      return;
    }

    const message: AlertMessage = {
      type: 'CVD_SLOPE',
      timestamp: payload.timestamp,
      value: payload.slopeZ,
      threshold: payload.threshold,
      message: this.buildCvdSlopeMessage(payload),
    };

    if (this.enableCvdSlopeDiscord) {
      await this.sendDiscordAlert(message);
    } else {
      logger.debug('CVD slope alert Discord notification disabled; recording history only', {
        alertType,
        bucketSpanMinutes: payload.bucketSpanMinutes,
        direction: payload.direction,
      });
    }

    await this.databaseManager.saveAlertHistory({
      alertType,
      timestamp: payload.timestamp,
      value: payload.slopeZ,
      threshold: payload.threshold,
      message: message.message,
    });

    this.emit('cvdAlert', message);
  }

  /**
   * Format final Discord payload content
   */
  private formatDiscordContent(message: AlertMessage): string {
    if (message.type === 'CVD_DELTA' || message.type === 'MARKET_TRADE_START' || message.type === 'CVD_SLOPE') {
      return message.message;
    }

    const formattedTime = JST_FORMATTER.format(new Date(message.timestamp));
    return [
      `**${message.type} アラート**`,
      message.message,
      `値: ${message.value.toFixed(4)} / 閾値: ${message.threshold.toFixed(4)}`,
      `時間: ${formattedTime}`,
    ].join('\n');
  }

  private getCvdAlertType(bucketSpanMinutes: number, direction: 'buy' | 'sell'): string {
    const directionLabel = direction === 'buy' ? 'BUY' : 'SELL';
    return `CVD_DELTA_${bucketSpanMinutes}M_${directionLabel}`;
  }

  private getMarketTradeStartAlertType(payload: MarketTradeStartPayload): string {
    const prefix =
      payload.strategy === 'SHORT_WINDOW_QUANTILE'
        ? 'MARKET_TRADE_START_SHORT_WINDOW'
        : 'MARKET_TRADE_START_LOG_Z';
    return payload.direction === 'buy' ? `${prefix}_BUY` : `${prefix}_SELL`;
  }

  private getCvdSlopeAlertType(spanMinutes: number, direction: 'buy' | 'sell'): string {
    const directionLabel = direction === 'buy' ? 'BUY' : 'SELL';
    return `CVD_SLOPE_${spanMinutes}M_${directionLabel}`;
  }

  /**
   * Post payload to Discord webhook with retry logic
   */
  private async postToDiscord(
    payload: unknown,
    options?: { onSuccess?: () => Promise<void>; errorContext?: string; headers?: Record<string, string> }
  ): Promise<void> {
    if (!this.webhookUrl) {
      logger.warn('Discord webhook URL is not configured.');
      return;
    }

    const webhookUrl = this.ensureWaitQuery(this.webhookUrl);
    const errorContext = options?.errorContext ?? 'Failed to send payload to Discord';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const axiosConfig = options?.headers ? { headers: options.headers } : undefined;
        const response = await this.httpClient.post(webhookUrl, payload, axiosConfig as any);
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
