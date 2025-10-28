/**
 * Unit tests for DeribitRestClient
 * Tests REST API calls, retry functionality, and periodic data collection
 */

import { DeribitRestClient } from '../rest-client';
import axios, { AxiosResponse } from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('DeribitRestClient', () => {
  let client: DeribitRestClient;
  let mockAxiosInstance: jest.Mocked<any>;

  beforeEach(() => {
    jest.resetAllMocks();
    
    // Create mock axios instance
    mockAxiosInstance = {
      get: jest.fn(),
      interceptors: {
        response: {
          use: jest.fn()
        }
      }
    };
    
    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    
    client = new DeribitRestClient({
      baseUrl: 'https://test.deribit.com/api/v2',
      timeout: 5000,
      maxRetries: 2,
      retryDelay: 100,
      intervalMs: 1000,
    });
  });

  afterEach(() => {
    client.stopPeriodicCollection();
    jest.clearAllTimers();
  });

  describe('Client Initialization', () => {
    it('should create axios instance with correct configuration', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://test.deribit.com/api/v2',
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });

    it('should setup response interceptor', () => {
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
    });

    it('should use default options when none provided', () => {
      new DeribitRestClient();
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://www.deribit.com/api/v2',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });
  });

  describe('API Connection Testing', () => {
    it('should test connection successfully', async () => {
      const mockResponse: AxiosResponse = {
        data: { result: { server_time: Date.now() } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

      const result = await client.testConnection();

      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/public/get_time', { params: {} });
    });

    it('should handle connection test failure', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const result = await client.testConnection();

      expect(result).toBe(false);
    });
  });

  describe('BTC Index Price Retrieval', () => {
    it('should get BTC index price successfully', async () => {
      const mockResponse: AxiosResponse = {
        data: { result: { index_price: 45000.5 } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

      const price = await client.getBTCIndexPrice();

      expect(price).toBe(45000.5);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/public/get_index_price', {
        params: { index_name: 'btc_usd' }
      });
    });

    it('should handle BTC index price retrieval error', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('API error'));

      await expect(client.getBTCIndexPrice()).rejects.toThrow('API error');
    });
  });

  describe('Option Data Collection', () => {
    const mockInstrumentsResponse: AxiosResponse = {
      data: {
        result: [
          { instrument_name: 'BTC-29DEC23-45000-C' },
          { instrument_name: 'BTC-29DEC23-45000-P' }
        ]
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    };

    const mockOrderBookResponse: AxiosResponse = {
      data: {
        result: {
          instrument_name: 'BTC-29DEC23-45000-C',
          underlying_price: 45000,
          mark_price: 1500,
          implied_volatility: 0.65,
          timestamp: Date.now(),
          greeks: {
            delta: 0.5,
            gamma: 0.001,
            theta: -10,
            vega: 50,
            rho: 5
          }
        }
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    };

    it('should collect option data successfully', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(mockInstrumentsResponse)
        .mockResolvedValueOnce(mockOrderBookResponse)
        .mockResolvedValueOnce(mockOrderBookResponse);

      const optionData = await client.collectOptionData();

      expect(optionData).toHaveLength(2);
      expect(optionData[0]).toMatchObject({
        symbol: 'BTC-29DEC23-45000-C',
        underlyingPrice: 45000,
        markPrice: 1500,
        impliedVolatility: 0.65,
        delta: 0.5,
        gamma: 0.001,
        theta: -10,
        vega: 50,
        rho: 5
      });
    });

    it('should handle empty instruments list', async () => {
      const emptyResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValueOnce(emptyResponse);

      const optionData = await client.collectOptionData();

      expect(optionData).toHaveLength(0);
    });

    it('should handle individual instrument errors gracefully', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(mockInstrumentsResponse)
        .mockRejectedValueOnce(new Error('Instrument error'))
        .mockRejectedValueOnce(new Error('Instrument error'))
        .mockRejectedValueOnce(new Error('Instrument error'))
        .mockResolvedValueOnce(mockOrderBookResponse);

      const optionData = await client.collectOptionData();

      // Should return data for successful instrument only
      expect(optionData).toHaveLength(1);
    });

    it('should filter out instruments with missing greeks', async () => {
      const invalidOrderBookResponse: AxiosResponse = {
        data: {
          result: {
            instrument_name: 'BTC-29DEC23-45000-C',
            underlying_price: 45000,
            mark_price: 1500,
            // Missing greeks
          }
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get
        .mockResolvedValueOnce(mockInstrumentsResponse)
        .mockResolvedValueOnce(invalidOrderBookResponse)
        .mockResolvedValueOnce(mockOrderBookResponse);

      const optionData = await client.collectOptionData();

      // Should only return valid instrument data
      expect(optionData).toHaveLength(1);
    });
  });

  describe('Option Summary Data', () => {
    it('should get BTC option summary successfully', async () => {
      const mockSummaryResponse: AxiosResponse = {
        data: {
          result: [{
            instrument_name: 'BTC-29DEC23-45000-C',
            underlying_price: 45000,
            mark_price: 1500,
            implied_volatility: 0.65,
            timestamp: Date.now(),
            greeks: {
              delta: 0.5,
              gamma: 0.001,
              theta: -10,
              vega: 50,
              rho: 5
            }
          }]
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValueOnce(mockSummaryResponse);

      const optionData = await client.getBTCOptionSummary();

      expect(optionData).toHaveLength(1);
      expect(optionData[0]).toMatchObject({
        symbol: 'BTC-29DEC23-45000-C',
        underlyingPrice: 45000,
        markPrice: 1500,
        impliedVolatility: 0.65,
        delta: 0.5
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/public/get_book_summary_by_currency', {
        params: { currency: 'BTC', kind: 'option' }
      });
    });

    it('should handle option summary error', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('Summary error'));

      await expect(client.getBTCOptionSummary()).rejects.toThrow('Summary error');
    });
  });

  describe('Retry Logic', () => {
    beforeEach(() => {
      client = new DeribitRestClient({
        baseUrl: 'https://test.deribit.com/api/v2',
        timeout: 5000,
        maxRetries: 2,
        retryDelay: 10,
        intervalMs: 1000,
      });
    });

    it('should retry failed requests with exponential backoff', async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          data: { result: { server_time: Date.now() } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

      const result = await client.testConnection();

      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retry attempts', async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.testConnection();
      expect(result).toBe(false);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3); // Original + 2 retries
    });
  });

  describe('Periodic Collection', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start periodic collection successfully', () => {
      const mockResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const startedSpy = jest.fn();
      client.on('periodicCollectionStarted', startedSpy);

      client.startPeriodicCollection();

      expect(startedSpy).toHaveBeenCalled();
      expect(client.isCollecting()).toBe(true);
    });

    it('should collect data immediately when starting', () => {
      const mockResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      client.startPeriodicCollection();

      // Should call API immediately
      expect(mockAxiosInstance.get).toHaveBeenCalled();
    });

    it('should collect data periodically', () => {
      const mockResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      client.startPeriodicCollection();

      // Clear initial call
      mockAxiosInstance.get.mockClear();

      // Fast-forward to trigger periodic collection
      jest.advanceTimersByTime(1000);

      expect(mockAxiosInstance.get).toHaveBeenCalled();
    });

    it('should stop periodic collection', () => {
      const mockResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const stoppedSpy = jest.fn();
      client.on('periodicCollectionStopped', stoppedSpy);

      client.startPeriodicCollection();
      client.stopPeriodicCollection();

      expect(stoppedSpy).toHaveBeenCalled();
      expect(client.isCollecting()).toBe(false);

      // Clear calls from start
      mockAxiosInstance.get.mockClear();

      // Fast-forward time - should not collect anymore
      jest.advanceTimersByTime(2000);

      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('should not start multiple collections', () => {
      const mockResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      client.startPeriodicCollection();
      client.startPeriodicCollection(); // Second call should be ignored

      expect(client.isCollecting()).toBe(true);
    });

    it('should emit option data when collected', async () => {
      const mockInstrumentsResponse: AxiosResponse = {
        data: { result: [{ instrument_name: 'BTC-29DEC23-45000-C' }] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      const mockOrderBookResponse: AxiosResponse = {
        data: {
          result: {
            instrument_name: 'BTC-29DEC23-45000-C',
            underlying_price: 45000,
            mark_price: 1500,
            implied_volatility: 0.65,
            timestamp: Date.now(),
            greeks: { delta: 0.5, gamma: 0.001, theta: -10, vega: 50, rho: 5 }
          }
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get
        .mockResolvedValueOnce(mockInstrumentsResponse)
        .mockResolvedValueOnce(mockOrderBookResponse);

      const dataPromise = new Promise((resolve) => {
        client.once('optionData', resolve);
      });

      client.startPeriodicCollection();
      await jest.runOnlyPendingTimersAsync();

      const data = (await dataPromise) as any[];
      expect(data).toHaveLength(1);
      expect(data[0].symbol).toBe('BTC-29DEC23-45000-C');
    });

    it('should handle collection errors gracefully', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('Collection error'));

      const errorPromise = new Promise((resolve) => {
        client.once('error', resolve);
      });

      client.startPeriodicCollection();
      await jest.runOnlyPendingTimersAsync();

      const error = (await errorPromise) as Error;
      expect(error.message).toBe('Collection error');
    });
  });

  describe('Interval Management', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should get current interval', () => {
      expect(client.getInterval()).toBe(1000);
    });

    it('should update interval and restart collection', () => {
      const mockResponse: AxiosResponse = {
        data: { result: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      client.startPeriodicCollection();
      client.setInterval(2000);

      expect(client.getInterval()).toBe(2000);

      // Clear initial calls
      mockAxiosInstance.get.mockClear();

      // Should not trigger at old interval
      jest.advanceTimersByTime(1000);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();

      // Should trigger at new interval
      jest.advanceTimersByTime(1000);
      expect(mockAxiosInstance.get).toHaveBeenCalled();
    });

    it('should update interval without restarting when not collecting', () => {
      client.setInterval(5000);
      expect(client.getInterval()).toBe(5000);
      expect(client.isCollecting()).toBe(false);
    });
  });
});
