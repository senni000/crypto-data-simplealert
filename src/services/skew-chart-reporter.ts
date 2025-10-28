import { EventEmitter } from 'events';
import { ChartConfiguration, ChartOptions } from 'chart.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import 'chart.js/auto';
import { IDatabaseManager } from './interfaces';
import { AlertManager } from './alert-manager';
import { logger } from '../utils/logger';
import { SkewRawData } from '../types';

export interface SkewChartReporterOptions {
  intervalMs?: number;
  lookbackDays?: number;
  chartWidth?: number;
  chartHeight?: number;
  filename?: string;
}

interface DailyDataPoint {
  date: Date;
  price: number;
  skew: number;
  movingAverage: number | null;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 160;
const MAX_MOVING_AVERAGE_WINDOW = 100;

export class SkewChartReporter extends EventEmitter {
  private readonly databaseManager: IDatabaseManager;
  private readonly alertManager: AlertManager;
  private readonly options: Required<SkewChartReporterOptions>;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly chartRenderer: ChartJSNodeCanvas;

  constructor(
    databaseManager: IDatabaseManager,
    alertManager: AlertManager,
    options: SkewChartReporterOptions = {}
  ) {
    super();
    this.databaseManager = databaseManager;
    this.alertManager = alertManager;
    this.options = {
      intervalMs: options.intervalMs ?? FOUR_HOURS_MS,
      lookbackDays: options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      chartWidth: options.chartWidth ?? 1400,
      chartHeight: options.chartHeight ?? 640,
      filename: options.filename ?? 'skew-report.png',
    };

    this.chartRenderer = new ChartJSNodeCanvas({
      width: this.options.chartWidth,
      height: this.options.chartHeight,
      backgroundColour: '#111827',
    });
  }

  start(): void {
    if (this.timer) {
      logger.warn('Skew chart reporter is already running');
      return;
    }

    logger.info('Starting skew chart reporter');
    void this.generateAndSendChart();
    this.timer = setInterval(() => {
      void this.generateAndSendChart();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async generateAndSendChart(): Promise<void> {
    if (this.isRunning) {
      logger.info('Previous skew chart generation still running, skipping this cycle');
      return;
    }

    this.isRunning = true;
    try {
      const dailyData = await this.buildDailyData();
      if (dailyData.length < 5) {
        logger.warn('Insufficient data to generate skew chart. Need at least 5 data points.');
        return;
      }

      const buffer = await this.renderChart(dailyData);
      const latestPoint = dailyData[dailyData.length - 1];
      if (!latestPoint) {
        return;
      }
      await this.postChart(buffer, latestPoint);
      this.emit('chartSent');
    } catch (error) {
      logger.error('Failed to generate skew chart', error);
      this.emit('error', error);
    } finally {
      this.isRunning = false;
    }
  }

  private async buildDailyData(): Promise<DailyDataPoint[]> {
    const sinceTimestamp =
      Date.now() - this.options.lookbackDays * 24 * 60 * 60 * 1000;

    const [callSeries, putSeries] = await Promise.all([
      this.databaseManager.getSkewRawSeries({
        expiryType: 'Front',
        deltaBucket: '25D',
        optionType: 'call',
        since: sinceTimestamp,
      }),
      this.databaseManager.getSkewRawSeries({
        expiryType: 'Front',
        deltaBucket: '25D',
        optionType: 'put',
        since: sinceTimestamp,
      }),
    ]);

    if (!callSeries.length || !putSeries.length) {
      return [];
    }

    const dailyMap = new Map<string, { call?: SkewRawData; put?: SkewRawData }>();

    for (const record of callSeries) {
      const bucket = this.toDateBucket(record.timestamp);
      const entry = dailyMap.get(bucket) ?? {};
      entry.call = record;
      dailyMap.set(bucket, entry);
    }

    for (const record of putSeries) {
      const bucket = this.toDateBucket(record.timestamp);
      const entry = dailyMap.get(bucket) ?? {};
      entry.put = record;
      dailyMap.set(bucket, entry);
    }

    const sortedEntries = Array.from(dailyMap.entries())
      .filter(([, entry]) => entry.call && entry.put)
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());

    const points: DailyDataPoint[] = [];

    for (const [dateKey, entry] of sortedEntries) {
      const call = entry.call!;
      const put = entry.put!;

      const indexPriceValues = [call.indexPrice, put.indexPrice].filter(
        (value): value is number => typeof value === 'number'
      );
      const fallbackPriceValues = [call.markPrice, put.markPrice].filter(
        (value): value is number => typeof value === 'number'
      );

      const priceSource = indexPriceValues.length
        ? indexPriceValues
        : fallbackPriceValues;

      if (!priceSource.length) {
        continue;
      }

      const price = priceSource.reduce((acc, value) => acc + value, 0) / priceSource.length;

      if (typeof price !== 'number') {
        continue;
      }

      const skew = (put.markIv - call.markIv) * 100;
      points.push({
        date: new Date(`${dateKey}T00:00:00Z`),
        price,
        skew,
        movingAverage: null,
      });
    }

    if (points.length === 0) {
      return [];
    }

    this.computeMovingAverage(points);
    return points;
  }

  private computeMovingAverage(points: DailyDataPoint[]): void {
    for (let i = 0; i < points.length; i++) {
      const windowSize = Math.min(i + 1, MAX_MOVING_AVERAGE_WINDOW);
      const slice = points.slice(Math.max(0, i - windowSize + 1), i + 1);
      const current = points[i];
      if (!current) {
        continue;
      }

      const sum = slice.reduce((acc, point) => acc + point.skew, 0);
      current.movingAverage = slice.length > 0 ? sum / slice.length : null;
    }
  }

  private async renderChart(points: DailyDataPoint[]): Promise<Buffer> {
    const labels = points.map((point) =>
      point.date.toISOString().slice(0, 10)
    );

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'BTC/USD',
            data: points.map((point) => point.price),
            yAxisID: 'y',
            borderColor: '#9ca3af',
            backgroundColor: 'rgba(156,163,175,0.3)',
            borderWidth: 2,
            fill: false,
            tension: 0.2,
          },
          {
            label: '1M 25Δ Skew',
            data: points.map((point) => point.skew),
            yAxisID: 'y1',
            borderColor: '#ec4899',
            backgroundColor: 'rgba(236,72,153,0.1)',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
          },
          {
            label: '100d MA',
            data: points.map((point) => point.movingAverage ?? null),
            yAxisID: 'y1',
            borderColor: '#f472b6',
            borderDash: [6, 4],
            backgroundColor: 'transparent',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
          },
        ],
      },
      options: this.buildChartOptions(),
    };

    return this.chartRenderer.renderToBuffer(config);
  }

  private buildChartOptions(): ChartOptions<'line'> {
    const textColor = '#d1d5db';
    const gridColor = 'rgba(75,85,99,0.3)';

    return {
      responsive: false,
      maintainAspectRatio: false,
      color: textColor,
      plugins: {
        legend: {
          labels: {
            color: textColor,
            font: { size: 14 },
          },
        },
        tooltip: {
          intersect: false,
          mode: 'index',
        },
      },
      scales: {
        x: {
          ticks: {
            color: textColor,
            maxRotation: 0,
          },
          grid: {
            color: gridColor,
          },
        },
        y: {
          position: 'left',
          ticks: {
            color: textColor,
            callback: (value) => `$${Number(value).toLocaleString()}`,
          },
          grid: {
            color: gridColor,
          },
        },
        y1: {
          position: 'right',
          ticks: {
            color: textColor,
            callback: (value) => `${Number(value).toFixed(1)}%`,
          },
          grid: {
            drawOnChartArea: false,
          },
        },
      },
    };
  }

  private async postChart(buffer: Buffer, latestPoint: DailyDataPoint): Promise<void> {
    const movingAverageText =
      typeof latestPoint.movingAverage === 'number'
        ? `${latestPoint.movingAverage.toFixed(2)}%`
        : 'N/A';

    const content = [
      '📈 **BTC/USD と 1M 25Δ Skew レポート**',
      `期間: 過去 ${this.options.lookbackDays} 日`,
      `最新日 (${latestPoint.date.toISOString().slice(0, 10)}):`,
      `- BTC/USD: $${latestPoint.price.toLocaleString()}`,
      `- Skew: ${latestPoint.skew.toFixed(2)}%`,
      `- 100d MA: ${movingAverageText}`,
    ].join('\n');

    await this.alertManager.sendDiscordImage({
      buffer,
      filename: this.options.filename,
      content,
    });
  }

  private toDateBucket(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().slice(0, 10);
  }
}
