import { AnalyticsAlertProcessor } from '../analytics-alert-processor';
import { AlertManager } from '../alert-manager';
import { IDatabaseManager } from '../interfaces';
import { ExpiryType, OrderFlowRatioData, SkewRawData } from '../../types';

describe('AnalyticsAlertProcessor', () => {
  let mockDatabaseManager: jest.Mocked<IDatabaseManager>;
  let mockAlertManager: jest.Mocked<AlertManager>;
  let processor: AnalyticsAlertProcessor;

  const ratioSeriesMap = new Map<string, OrderFlowRatioData[]>();
  const skewSeriesMap = new Map<string, SkewRawData[]>();

  beforeEach(() => {
    ratioSeriesMap.clear();
    skewSeriesMap.clear();
    mockDatabaseManager = {
      getOrderFlowRatioSeries: jest.fn((params) => {
        const key = ratioKey(params.expiryType, params.optionType);
        return Promise.resolve(ratioSeriesMap.get(key) ?? []);
      }),
      getSkewRawSeries: jest.fn((params) => {
        const key = skewKey(params.expiryType, params.optionType);
        return Promise.resolve(skewSeriesMap.get(key) ?? []);
      }),
    } as unknown as jest.Mocked<IDatabaseManager>;

    mockAlertManager = {
      sendDiscordAlert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AlertManager>;

    processor = new AnalyticsAlertProcessor(mockDatabaseManager, mockAlertManager, {
      ratioZScoreThreshold: 1.5,
      ratioDerivativeThreshold: 0.5,
      callRrThreshold: -0.02,
      putRrThreshold: 0.02,
      callSlopeThreshold: -0.05,
      putSlopeThreshold: 0.05,
      dRrThreshold: 0.01,
      dSlopeThreshold: 0.02,
      ratioLookbackMs: 60 * 60 * 1000,
      skewLookbackMs: 60 * 60 * 1000,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('emits ratio and skew alerts for call direction', async () => {
    const baseTimestamp = Date.now();
    setupRatioSeries('0DTE', 'call', baseTimestamp, [0.8, 0.9, 1.0, 1.2, 1.6, 2.2]);
    setupRatioSeries('0DTE', 'put', baseTimestamp, [0.8, 0.9, 1.0, 1.2, 1.3, 1.4]);

    setupSkewSeries('0DTE', baseTimestamp, {
      call: [0.55, 0.57, 0.60, 0.62, 0.64, 0.68],
      put: [0.50, 0.49, 0.48, 0.47, 0.46, 0.45],
    });

    await processor.processLatestAnalytics(baseTimestamp);

    expect(mockAlertManager.sendDiscordAlert).toHaveBeenCalled();
    const alertTypes = mockAlertManager.sendDiscordAlert.mock.calls.map((call) => call[0].type);
    expect(alertTypes).toContain('RATIO_SPIKE_CALL');
    expect(alertTypes).toContain('SKEW_SPIKE_CALL');
    expect(alertTypes).toContain('COMBO_CALL');
  });

  it('emits put-side combo when skew precedes ratio', async () => {
    const baseTimestamp = Date.now();
    setupRatioSeries('Front', 'call', baseTimestamp, [1, 1, 1, 1]);
    setupRatioSeries('Front', 'put', baseTimestamp, [0.8, 1.0, 1.5, 2.5, 3.2]);

    // Skew spike one minute before ratio
    setupSkewSeries('Front', baseTimestamp - 60 * 1000, {
      call: [0.5, 0.49, 0.50, 0.51, 0.50],
      put: [0.6, 0.63, 0.67, 0.72, 0.78],
    });

    await processor.processLatestAnalytics(baseTimestamp - 60 * 1000);
    await processor.processLatestAnalytics(baseTimestamp);

    const alertTypes = mockAlertManager.sendDiscordAlert.mock.calls.map((call) => call[0].type);
    expect(alertTypes).toContain('RATIO_SPIKE_PUT');
    expect(alertTypes).toContain('SKEW_SPIKE_PUT');
    expect(alertTypes).toContain('COMBO_PUT');
  });

  function setupRatioSeries(
    expiryType: ExpiryType,
    optionType: 'call' | 'put',
    startTimestamp: number,
    values: number[]
  ): void {
    const series = values.map((ratio, index) => ({
      timestamp: startTimestamp - (values.length - index) * 60 * 1000,
      expiryType,
      expiryTimestamp: startTimestamp,
      deltaBucket: '25D' as const,
      optionType,
      ratio,
    }));
    ratioSeriesMap.set(ratioKey(expiryType, optionType), series);
  }

  function setupSkewSeries(
    expiryType: ExpiryType,
    startTimestamp: number,
    values: { call: number[]; put: number[] }
  ): void {
    const callSeries = values.call.map((iv, index) => ({
      timestamp: startTimestamp - (values.call.length - index) * 60 * 1000,
      expiryType,
      expiryTimestamp: startTimestamp,
      deltaBucket: '25D' as const,
      optionType: 'call' as const,
      markIv: iv,
      markPrice: 0,
      delta: 0,
      indexPrice: 100000,
    }));

    const putSeries = values.put.map((iv, index) => ({
      timestamp: startTimestamp - (values.put.length - index) * 60 * 1000,
      expiryType,
      expiryTimestamp: startTimestamp,
      deltaBucket: '25D' as const,
      optionType: 'put' as const,
      markIv: iv,
      markPrice: 0,
      delta: 0,
      indexPrice: 100000,
    }));
    skewSeriesMap.set(skewKey(expiryType, 'call'), callSeries as SkewRawData[]);
    skewSeriesMap.set(skewKey(expiryType, 'put'), putSeries as SkewRawData[]);
  }

  function ratioKey(expiry: ExpiryType, option: 'call' | 'put'): string {
    return `${expiry}-${option}`;
  }

  function skewKey(expiry: ExpiryType, option: 'call' | 'put'): string {
    return `${expiry}-${option}`;
  }
});
