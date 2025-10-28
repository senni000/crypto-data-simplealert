/**
 * REST API client for Deribit API
 * Handles option data collection with retry functionality
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { OptionData } from '../types';

export interface DeribitOptionInstrument {
  instrument_name: string;
  underlying_price: number;
  mark_price: number;
  implied_volatility: number;
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
  timestamp: number;
}

export interface DeribitOptionResponse {
  jsonrpc: string;
  id: number;
  result: DeribitOptionInstrument[];
}

export interface RestClientOptions {
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  intervalMs?: number;
}

/**
 * REST API client for Deribit with retry functionality and periodic data collection
 */
export class DeribitRestClient extends EventEmitter {
  private axiosInstance: AxiosInstance;
  private options: Required<RestClientOptions>;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: RestClientOptions = {}) {
    super();

    this.options = {
      baseUrl: options.baseUrl || 'https://www.deribit.com/api/v2',
      timeout: options.timeout || 10000,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      intervalMs: options.intervalMs || 3600000, // 1 hour default
    };

    this.axiosInstance = axios.create({
      baseURL: this.options.baseUrl,
      timeout: this.options.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add response interceptor for error handling
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('REST API request failed:', error.message);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Start periodic option data collection
   */
  startPeriodicCollection(): void {
    if (this.isRunning) {
      console.log('Periodic collection is already running');
      return;
    }

    this.isRunning = true;
    console.log(`Starting periodic option data collection every ${this.options.intervalMs}ms`);

    // Collect data immediately
    this.collectOptionData();

    // Set up interval for periodic collection
    this.intervalTimer = setInterval(() => {
      this.collectOptionData();
    }, this.options.intervalMs);

    this.emit('periodicCollectionStarted');
  }

  /**
   * Stop periodic option data collection
   */
  stopPeriodicCollection(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    console.log('Stopped periodic option data collection');
    this.emit('periodicCollectionStopped');
  }

  /**
   * Collect BTC option data
   */
  async collectOptionData(): Promise<OptionData[]> {
    try {
      console.log('Collecting BTC option data...');
      
      const optionData = await this.getBTCOptionData();
      
      if (optionData.length > 0) {
        console.log(`Collected ${optionData.length} option instruments`);
        this.emit('optionData', optionData);
      } else {
        console.warn('No option data received');
      }

      return optionData;

    } catch (error) {
      console.error('Failed to collect option data:', error);
      this.emit('error', error);
      return [];
    }
  }

  /**
   * Get BTC option instruments data
   */
  async getBTCOptionData(): Promise<OptionData[]> {
    const instruments = await this.getBTCOptionInstruments();
    const collectedAt = Date.now();
    const concurrency = 4;
    const results: OptionData[] = [];
    let index = 0;

    const worker = async () => {
      while (index < instruments.length) {
        const instrument = instruments[index++];
        if (!instrument) {
          break;
        }

        try {
          const detailData = await this.getInstrumentData(instrument, collectedAt);
          if (detailData) {
            results.push(detailData);
          }
        } catch (error) {
          console.error(`Failed to get data for instrument ${instrument}:`, error);
        }

        await this.sleep(50);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, instruments.length) }, () => worker());
    await Promise.all(workers);

    return results;
  }

  /**
   * Get list of BTC option instruments
   */
  private async getBTCOptionInstruments(): Promise<string[]> {
    const response = await this.makeRequest<{ result: Array<{ instrument_name: string }> }>(
      '/public/get_instruments',
      {
        currency: 'BTC',
        kind: 'option',
        expired: false
      }
    );

    return response.result.map(instrument => instrument.instrument_name);
  }

  /**
   * Get detailed data for a specific instrument
   */
  private async getInstrumentData(instrumentName: string, collectedAt: number): Promise<OptionData | null> {
    try {
      const response = await this.makeRequest<{ result: DeribitOptionInstrument }>(
        '/public/get_order_book',
        {
          instrument_name: instrumentName,
          depth: 1
        }
      );

      const instrument = response.result;
      
      // Validate that we have all required data
      if (!instrument.greeks || typeof instrument.underlying_price !== 'number') {
        return null;
      }

      const optionData: OptionData = {
        symbol: instrument.instrument_name,
        timestamp: collectedAt,
        underlyingPrice: instrument.underlying_price,
        markPrice: instrument.mark_price || 0,
        impliedVolatility: instrument.implied_volatility || 0,
        delta: instrument.greeks.delta || 0,
        gamma: instrument.greeks.gamma || 0,
        theta: instrument.greeks.theta || 0,
        vega: instrument.greeks.vega || 0,
        rho: instrument.greeks.rho || 0,
      };

      return optionData;

    } catch (error) {
      console.error(`Error getting instrument data for ${instrumentName}:`, error);
      return null;
    }
  }

  /**
   * Make HTTP request with retry functionality
   */
  private async makeRequest<T>(
    endpoint: string,
    params: Record<string, any> = {},
    retryCount = 0
  ): Promise<T> {
    try {
      const response: AxiosResponse<T> = await this.axiosInstance.get(endpoint, {
        params
      });

      return response.data;

    } catch (error) {
      if (retryCount < this.options.maxRetries) {
        const delay = this.options.retryDelay * Math.pow(2, retryCount);
        console.log(`Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.options.maxRetries})`);
        
        await this.sleep(delay);
        return this.makeRequest<T>(endpoint, params, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Get BTC option summary data (alternative method for bulk data)
   */
  async getBTCOptionSummary(): Promise<OptionData[]> {
    try {
      const response = await this.makeRequest<{ result: DeribitOptionInstrument[] }>(
        '/public/get_book_summary_by_currency',
        {
          currency: 'BTC',
          kind: 'option'
        }
      );

      const optionData: OptionData[] = [];

      for (const instrument of response.result) {
        if (instrument.greeks && typeof instrument.underlying_price === 'number') {
          const data: OptionData = {
            symbol: instrument.instrument_name,
            timestamp: instrument.timestamp || Date.now(),
            underlyingPrice: instrument.underlying_price,
            markPrice: instrument.mark_price || 0,
            impliedVolatility: instrument.implied_volatility || 0,
            delta: instrument.greeks.delta || 0,
            gamma: instrument.greeks.gamma || 0,
            theta: instrument.greeks.theta || 0,
            vega: instrument.greeks.vega || 0,
            rho: instrument.greeks.rho || 0,
          };

          optionData.push(data);
        }
      }

      return optionData;

    } catch (error) {
      console.error('Failed to get BTC option summary:', error);
      throw error;
    }
  }

  /**
   * Get current BTC index price
   */
  async getBTCIndexPrice(): Promise<number> {
    try {
      const response = await this.makeRequest<{ result: { index_price: number } }>(
        '/public/get_index_price',
        {
          index_name: 'btc_usd'
        }
      );

      return response.result.index_price;

    } catch (error) {
      console.error('Failed to get BTC index price:', error);
      throw error;
    }
  }

  /**
   * Test API connectivity
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.makeRequest<{ result: number | { server_time: number } }>(
        '/public/get_time'
      );

      const serverTimeValue =
        typeof response.result === 'number'
          ? response.result
          : typeof response.result?.server_time === 'number'
            ? response.result.server_time
            : null;

      if (serverTimeValue) {
        console.log(
          'API connection test successful, server time:',
          new Date(serverTimeValue).toISOString()
        );
      } else {
        console.log('API connection test successful, server time unavailable in response');
      }
      return true;

    } catch (error) {
      console.error('API connection test failed:', error);
      return false;
    }
  }

  /**
   * Utility function to sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current collection status
   */
  isCollecting(): boolean {
    return this.isRunning;
  }

  /**
   * Get collection interval
   */
  getInterval(): number {
    return this.options.intervalMs;
  }

  /**
   * Update collection interval
   */
  setInterval(intervalMs: number): void {
    this.options.intervalMs = intervalMs;
    
    if (this.isRunning) {
      // Restart with new interval
      this.stopPeriodicCollection();
      this.startPeriodicCollection();
    }
  }
}
