import {
  CVDCalculator,
  ZScoreCalculator,
  CPDelta25Calculator,
  MovingAverageMonitor,
} from '../calculation-engine';
import { TradeData, OptionData, CVDData } from '../../types';

describe('CVDCalculator', () => {
  const baseTrade: Omit<TradeData, 'amount' | 'direction' | 'symbol' | 'tradeId'> = {
    timestamp: Date.now(),
    price: 50000,
  };

  it('calculates cumulative volume delta across buys and sells', () => {
    const trades: TradeData[] = [
      { ...baseTrade, amount: 2, direction: 'buy', symbol: 'BTC-PERPETUAL', tradeId: 't-1' },
      { ...baseTrade, amount: 1, direction: 'sell', symbol: 'BTC-PERPETUAL', tradeId: 't-2' },
      { ...baseTrade, amount: 3, direction: 'buy', symbol: 'BTC-PERPETUAL', tradeId: 't-3' },
      { ...baseTrade, amount: 1.5, direction: 'sell', symbol: 'BTC-PERPETUAL', tradeId: 't-4' },
    ];

    const cvd = CVDCalculator.calculateCVD(trades);
    expect(cvd).toBeCloseTo(2.5);
  });

  it('filters for BTC perpetual symbols when calculating BTC CVD', () => {
    const trades: TradeData[] = [
      { ...baseTrade, amount: 1, direction: 'buy', symbol: 'BTC-PERPETUAL', tradeId: 't-1' },
      { ...baseTrade, amount: 0.5, direction: 'sell', symbol: 'ETH-PERPETUAL', tradeId: 't-2' },
      { ...baseTrade, amount: 1.5, direction: 'buy', symbol: 'BTC-25MAR22-PERP', tradeId: 't-3' },
      { ...baseTrade, amount: 2, direction: 'sell', symbol: 'BTC-30SEP22', tradeId: 't-4' },
    ];

    const cvd = CVDCalculator.calculateBTCPerpetualCVD(trades);
    expect(cvd).toBeCloseTo(2.5);
  });

  it('adds incremental values to current CVD', () => {
    const newTrades: TradeData[] = [
      { ...baseTrade, amount: 1, direction: 'buy', symbol: 'BTC-PERPETUAL', tradeId: 't-5' },
      { ...baseTrade, amount: 0.5, direction: 'sell', symbol: 'BTC-PERPETUAL', tradeId: 't-6' },
    ];

    const nextCVD = CVDCalculator.calculateIncrementalCVD(10, newTrades);
    expect(nextCVD).toBeCloseTo(10.5);
  });
});

describe('ZScoreCalculator', () => {
  it('computes z-score based on historical values', () => {
    const historical = [10, 12, 14, 16, 18];
    const zScore = ZScoreCalculator.calculateZScore(20, historical);
    expect(zScore).toBeCloseTo(2.1213, 4); // (20 - 14) / stddev(≈2.8284) ≈ 2.1213
  });

  it('returns 0 when historical values are empty', () => {
    const zScore = ZScoreCalculator.calculateZScore(10, []);
    expect(zScore).toBe(0);
  });

  it('returns 0 when historical variance is zero', () => {
    const zScore = ZScoreCalculator.calculateZScore(10, [10, 10, 10]);
    expect(zScore).toBe(0);
  });

  it('derives z-score from CVD historical data', () => {
    const historical: CVDData[] = [
      { timestamp: 1, cvdValue: 5, zScore: 0 },
      { timestamp: 2, cvdValue: 10, zScore: 0 },
      { timestamp: 3, cvdValue: 15, zScore: 0 },
    ];

    const zScore = ZScoreCalculator.calculateCVDZScore(20, historical);
    expect(zScore).toBeCloseTo(2.449, 2);
  });
});

describe('CPDelta25Calculator', () => {
  const optionBase: Omit<OptionData, 'delta' | 'symbol'> = {
    timestamp: Date.now(),
    underlyingPrice: 50000,
    markPrice: 1000,
    impliedVolatility: 0.8,
    gamma: 0.02,
    theta: -0.01,
    vega: 0.5,
    rho: 0.03,
  };

  it('selects closest call and put options to ±0.25 delta and computes cp delta', () => {
    const options: OptionData[] = [
      { ...optionBase, symbol: 'BTC-25MAR22-50000-C', delta: 0.23 },
      { ...optionBase, symbol: 'BTC-25MAR22-52000-C', delta: 0.31 },
      { ...optionBase, symbol: 'BTC-25MAR22-50000-P', delta: -0.24 },
      { ...optionBase, symbol: 'BTC-25MAR22-52000-P', delta: -0.35 },
    ];

    const result = CPDelta25Calculator.calculateCPDelta25(options);

    expect(result.call?.symbol).toBe('BTC-25MAR22-50000-C');
    expect(result.put?.symbol).toBe('BTC-25MAR22-50000-P');
    expect(result.cpDelta).toBeCloseTo(0.47);
  });

  it('returns default values when no options provided', () => {
    const result = CPDelta25Calculator.calculateCPDelta25([]);
    expect(result.call).toBeNull();
    expect(result.put).toBeNull();
    expect(result.cpDelta).toBe(0);
  });

  it('calculates moving average using the most recent period values', () => {
    const values = [1, 2, 3, 4, 5, 6];
    const movingAverage = CPDelta25Calculator.calculateMovingAverage(values, 3);
    expect(movingAverage).toBeCloseTo((4 + 5 + 6) / 3);
  });

  it('detects significant percentage change above threshold', () => {
    const hasChange = CPDelta25Calculator.detectSignificantChange(1.1, 1, 0.05);
    expect(hasChange).toBe(true);
  });

  it('ignores change when previous moving average is zero', () => {
    const hasChange = CPDelta25Calculator.detectSignificantChange(1, 0, 0.05);
    expect(hasChange).toBe(false);
  });
});

describe('MovingAverageMonitor', () => {
  it('alerts when moving average change exceeds threshold and cooldown has passed', () => {
    const monitor = new MovingAverageMonitor(3, 0.1, 0); // zero cooldown for easier testing
    const timestamp = Date.now();

    let result = monitor.addValue(1, timestamp);
    expect(result.shouldAlert).toBe(false);

    result = monitor.addValue(1, timestamp + 1);
    expect(result.shouldAlert).toBe(false);

    result = monitor.addValue(1, timestamp + 2);
    expect(result.shouldAlert).toBe(false);

    result = monitor.addValue(3, timestamp + 3);
    expect(result.shouldAlert).toBe(true);
    expect(result.previousMA).toBeGreaterThan(0);
    expect(result.currentMA).toBeGreaterThan(result.previousMA);
  });

  it('suppresses alerts during cooldown', () => {
    const monitor = new MovingAverageMonitor(2, 0.1, 10); // 10 minute cooldown
    const timestamp = Date.now();

    monitor.addValue(1, timestamp);
    monitor.addValue(1, timestamp + 1);
    const firstAlert = monitor.addValue(2, timestamp + 2);
    expect(firstAlert.shouldAlert).toBe(true);

    const suppressed = monitor.addValue(3, timestamp + 3);
    expect(suppressed.shouldAlert).toBe(false);
  });
});
