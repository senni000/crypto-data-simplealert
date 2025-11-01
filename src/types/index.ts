/**
 * Core data types for the Crypto Data Alert System
 */

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
  type:
    | 'CP_DELTA_25'
    | 'CVD_DELTA'
    | 'MARKET_TRADE_START'
    | 'CVD_SLOPE'
    | 'COMBO_CALL'
    | 'COMBO_PUT';
  timestamp: number;
  value: number;
  threshold: number;
  message: string;
}

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

export interface TradeDataRow extends TradeData {
  rowId: number;
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
 * CVD (Cumulative Volume Delta) data structure
 */
export interface CVDData {
  symbol: string;
  timestamp: number;
  cvdValue: number;
  zScore: number;
  delta: number;
  deltaZScore: number;
  bucketSpanMinutes: number;
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

export interface AlertQueueRecord {
  id: number;
  alertType: string;
  timestamp: number;
  payload: QueuedAlertPayload;
  attemptCount: number;
  lastError?: string | null;
  processedAt?: number | null;
  createdAt?: number;
}

export interface CvdDeltaAlertPayload {
  symbol: string;
  timestamp: number;
  bucketSpanMinutes: number;
  delta: number;
  zScore: number;
  threshold: number;
  direction: 'buy' | 'sell';
  windowHours: number;
}

export interface MarketTradeStartPayload {
  symbol: string;
  timestamp: number;
  tradeId: string;
  direction: 'buy' | 'sell';
  amount: number;
  quantile: number;
  quantileLevel: number;
  secondaryQuantile?: number;
  scale?: number;
  threshold: number;
  windowHours: number;
}

export interface CvdSlopeAlertPayload {
  symbol: string;
  timestamp: number;
  bucketSpanMinutes: number;
  delta: number;
  slope: number;
  slopeZ: number;
  threshold: number;
  direction: 'buy' | 'sell';
  windowHours: number;
}

export type QueuedAlertPayload =
  | CvdDeltaAlertPayload
  | MarketTradeStartPayload
  | CvdSlopeAlertPayload;
