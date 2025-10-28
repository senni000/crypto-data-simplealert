/**
 * Calculation Engine Implementation
 * Handles CVD calculations, Z-score monitoring, and C-P Delta 25 calculations
 */

import { TradeData, OptionData, CVDData } from '../types';

/**
 * CVD Calculator class for Cumulative Volume Delta calculations
 */
export class CVDCalculator {
  /**
   * Calculate Cumulative Volume Delta from trade data
   * CVD = Σ(buy_volume - sell_volume)
   */
  static calculateCVD(tradeData: TradeData[]): number {
    let cvd = 0;
    
    for (const trade of tradeData) {
      const volume = trade.amount;
      if (trade.direction === 'buy') {
        cvd += volume;
      } else if (trade.direction === 'sell') {
        cvd -= volume;
      }
    }
    
    return cvd;
  }

  /**
   * Calculate CVD for perpetual BTC trades only
   * Filters for BTC perpetual symbols and calculates CVD
   */
  static calculateBTCPerpetualCVD(tradeData: TradeData[]): number {
    // Filter for BTC perpetual trades (symbols containing "BTC" and "PERPETUAL")
    const btcPerpetualTrades = tradeData.filter(trade => 
      trade.symbol.includes('BTC') && 
      (trade.symbol.includes('PERPETUAL') || trade.symbol.includes('-PERP'))
    );
    
    return this.calculateCVD(btcPerpetualTrades);
  }

  /**
   * Calculate incremental CVD from new trade data
   * Used for real-time CVD updates
   */
  static calculateIncrementalCVD(currentCVD: number, newTrades: TradeData[]): number {
    const incrementalCVD = this.calculateCVD(newTrades);
    return currentCVD + incrementalCVD;
  }
}

/**
 * Z-Score Calculator class for statistical analysis
 */
export class ZScoreCalculator {
  /**
   * Calculate Z-score for a given value against historical data
   * Z-score = (value - mean) / standard_deviation
   */
  static calculateZScore(value: number, historicalValues: number[]): number {
    if (historicalValues.length === 0) {
      return 0;
    }

    const mean = this.calculateMean(historicalValues);
    const standardDeviation = this.calculateStandardDeviation(historicalValues, mean);
    
    // Avoid division by zero
    if (standardDeviation === 0) {
      return 0;
    }
    
    return (value - mean) / standardDeviation;
  }

  /**
   * Calculate mean (average) of an array of numbers
   */
  private static calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, val) => acc + val, 0);
    return sum / values.length;
  }

  /**
   * Calculate standard deviation of an array of numbers
   */
  private static calculateStandardDeviation(values: number[], mean?: number): number {
    if (values.length === 0) return 0;
    
    const calculatedMean = mean ?? this.calculateMean(values);
    const squaredDifferences = values.map(value => Math.pow(value - calculatedMean, 2));
    const variance = squaredDifferences.reduce((acc, val) => acc + val, 0) / values.length;
    
    return Math.sqrt(variance);
  }

  /**
   * Calculate Z-score for CVD data using historical CVD values
   */
  static calculateCVDZScore(currentCVD: number, historicalCVDData: CVDData[]): number {
    const historicalValues = historicalCVDData.map(data => data.cvdValue);
    return this.calculateZScore(currentCVD, historicalValues);
  }
}

/**
 * CVD Monitor class for Z-score threshold monitoring
 */
export class CVDMonitor {
  private threshold: number;
  private lastAlertTime: number = 0;
  private cooldownPeriod: number = 30 * 60 * 1000; // 30 minutes in milliseconds

  constructor(threshold: number = 2.0, cooldownMinutes: number = 30) {
    this.threshold = threshold;
    this.cooldownPeriod = cooldownMinutes * 60 * 1000;
  }

  /**
   * Check if CVD Z-score exceeds threshold and alert conditions are met
   */
  checkZScoreThreshold(zScore: number, timestamp: number): boolean {
    // Check if Z-score exceeds threshold
    if (Math.abs(zScore) < this.threshold) {
      return false;
    }

    // Check cooldown period to prevent spam alerts
    if (timestamp - this.lastAlertTime < this.cooldownPeriod) {
      return false;
    }

    // Update last alert time
    this.lastAlertTime = timestamp;
    return true;
  }

  /**
   * Get current threshold value
   */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Update threshold value
   */
  setThreshold(newThreshold: number): void {
    this.threshold = newThreshold;
  }

  /**
   * Get cooldown period in milliseconds
   */
  getCooldownPeriod(): number {
    return this.cooldownPeriod;
  }

  /**
   * Set cooldown period in minutes
   */
  setCooldownPeriod(minutes: number): void {
    this.cooldownPeriod = minutes * 60 * 1000;
  }

  /**
   * Reset alert cooldown (for testing or manual reset)
   */
  resetCooldown(): void {
    this.lastAlertTime = 0;
  }
}

/**
 * Call-Put Delta 25 Calculator class
 */
export class CPDelta25Calculator {
  /**
   * Calculate Call-Put Delta 25 from option data
   * Finds options with delta closest to 0.25 (call) and -0.25 (put)
   */
  static calculateCPDelta25(optionData: OptionData[]): { call: OptionData | null, put: OptionData | null, cpDelta: number } {
    if (optionData.length === 0) {
      return { call: null, put: null, cpDelta: 0 };
    }

    // Separate calls and puts based on delta sign
    const calls = optionData.filter(option => option.delta > 0);
    const puts = optionData.filter(option => option.delta < 0);

    // Find call option closest to delta 0.25
    let closestCall: OptionData | null = null;
    let minCallDiff = Infinity;
    
    for (const call of calls) {
      const diff = Math.abs(call.delta - 0.25);
      if (diff < minCallDiff) {
        minCallDiff = diff;
        closestCall = call;
      }
    }

    // Find put option closest to delta -0.25
    let closestPut: OptionData | null = null;
    let minPutDiff = Infinity;
    
    for (const put of puts) {
      const diff = Math.abs(put.delta - (-0.25));
      if (diff < minPutDiff) {
        minPutDiff = diff;
        closestPut = put;
      }
    }

    // Calculate C-P Delta 25 (Call Delta - Put Delta)
    let cpDelta = 0;
    if (closestCall && closestPut) {
      cpDelta = closestCall.delta - closestPut.delta;
    }

    return {
      call: closestCall,
      put: closestPut,
      cpDelta
    };
  }

  /**
   * Calculate moving average of C-P Delta 25 values
   */
  static calculateMovingAverage(values: number[], period: number): number {
    if (values.length === 0 || period <= 0) {
      return 0;
    }

    // Use the last 'period' values for moving average
    const relevantValues = values.slice(-period);
    const sum = relevantValues.reduce((acc, val) => acc + val, 0);
    
    return sum / relevantValues.length;
  }

  /**
   * Detect significant change in moving average
   * Returns true if the change exceeds the threshold percentage
   */
  static detectSignificantChange(
    currentMA: number, 
    previousMA: number, 
    changeThreshold: number = 0.05 // 5% default threshold
  ): boolean {
    if (previousMA === 0) {
      return false; // Cannot calculate percentage change
    }

    const percentageChange = Math.abs((currentMA - previousMA) / previousMA);
    return percentageChange >= changeThreshold;
  }
}

/**
 * Moving Average Monitor class for C-P Delta 25 monitoring
 */
export class MovingAverageMonitor {
  private period: number;
  private changeThreshold: number;
  private historicalValues: number[] = [];
  private lastAlertTime: number = 0;
  private cooldownPeriod: number = 15 * 60 * 1000; // 15 minutes in milliseconds

  constructor(period: number = 10, changeThreshold: number = 0.05, cooldownMinutes: number = 15) {
    this.period = period;
    this.changeThreshold = changeThreshold;
    this.cooldownPeriod = cooldownMinutes * 60 * 1000;
  }

  /**
   * Add new C-P Delta 25 value and check for significant changes
   */
  addValue(value: number, timestamp: number): { shouldAlert: boolean, currentMA: number, previousMA: number } {
    // Calculate previous moving average
    const previousMA = CPDelta25Calculator.calculateMovingAverage(this.historicalValues, this.period);
    
    // Add new value to historical data
    this.historicalValues.push(value);
    
    // Keep only the data we need for moving average calculation
    if (this.historicalValues.length > this.period * 2) {
      this.historicalValues = this.historicalValues.slice(-this.period * 2);
    }

    // Calculate current moving average
    const currentMA = CPDelta25Calculator.calculateMovingAverage(this.historicalValues, this.period);

    // Check for significant change
    const hasSignificantChange = CPDelta25Calculator.detectSignificantChange(
      currentMA, 
      previousMA, 
      this.changeThreshold
    );

    // Check cooldown period
    const isInCooldown = timestamp - this.lastAlertTime < this.cooldownPeriod;

    const shouldAlert = hasSignificantChange && !isInCooldown && this.historicalValues.length >= this.period;

    if (shouldAlert) {
      this.lastAlertTime = timestamp;
    }

    return {
      shouldAlert,
      currentMA,
      previousMA
    };
  }

  /**
   * Get current moving average period
   */
  getPeriod(): number {
    return this.period;
  }

  /**
   * Get current change threshold
   */
  getChangeThreshold(): number {
    return this.changeThreshold;
  }

  /**
   * Reset historical data and cooldown
   */
  reset(): void {
    this.historicalValues = [];
    this.lastAlertTime = 0;
  }

  /**
   * Get current historical values count
   */
  getHistoricalCount(): number {
    return this.historicalValues.length;
  }
}