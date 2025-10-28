/**
 * Core data types for the Crypto Data Alert System
 */

/**
 * Trade data structure for storing transaction information
 */
export interface TradeData {
  symbol: string;
  timestamp: number;
  price: number;
  amount: number;
  direction: 'buy' | 'sell';
  tradeId: string;
  channel?: string;
  markPrice?: number;
  indexPrice?: number;
  underlyingPrice?: number;
  iv?: number;
  isBlockTrade?: boolean;
}

/**
 * Option data structure for storing option-related information
 */
export interface OptionData {
  symbol: string;
  timestamp: number;
  underlyingPrice: number;
  markPrice: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

/**
 * Option expiry分類
 */
export type ExpiryType = '0DTE' | 'Front' | 'Next' | 'Quarterly';

/**
 * 対象デルタ帯
 */
export type DeltaBucket = '10D' | '25D' | 'ATM';

/**
 * オプション種別
 */
export type OptionType = 'call' | 'put';

/**
 * 板圧力（Bid/Ask Ratio）用のデータ構造
 */
export interface OrderFlowRatioData {
  timestamp: number;
  expiryType: ExpiryType;
  expiryTimestamp?: number;
  deltaBucket: DeltaBucket;
  optionType: OptionType;
  ratio: number;
}

/**
 * Skew Impulse向けの生データ構造
 */
export interface SkewRawData {
  timestamp: number;
  expiryType: ExpiryType;
  expiryTimestamp?: number;
  deltaBucket: DeltaBucket;
  optionType: OptionType;
  markIv: number;
  markPrice: number;
  delta: number;
  indexPrice: number;
}

/**
 * Alert message structure for notifications
 */
export interface AlertMessage {
  type: 'CP_DELTA_25' | 'CVD_ZSCORE';
  timestamp: number;
  value: number;
  threshold: number;
  message: string;
}

/**
 * CVD (Cumulative Volume Delta) data structure
 */
export interface CVDData {
  timestamp: number;
  cvdValue: number;
  zScore: number;
}

/**
 * Alert history record structure
 */
export interface AlertHistory {
  id?: number;
  alertType: string;
  timestamp: number;
  value: number;
  threshold: number;
  message: string;
  createdAt?: string;
}
