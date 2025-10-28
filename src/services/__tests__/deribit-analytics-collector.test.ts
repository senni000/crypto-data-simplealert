import { DeribitAnalyticsCollector } from '../deribit-analytics-collector';
import { IDatabaseManager } from '../interfaces';

describe('DeribitAnalyticsCollector', () => {
  let collector: DeribitAnalyticsCollector;
  let mockDatabaseManager: jest.Mocked<IDatabaseManager>;

  beforeEach(() => {
    mockDatabaseManager = {
      initializeDatabase: jest.fn(),
      saveTradeData: jest.fn(),
      saveOptionData: jest.fn(),
      getTradeDataLast24Hours: jest.fn(),
      getLatestOptionData: jest.fn(),
      saveCVDData: jest.fn(),
      getCVDDataLast24Hours: jest.fn(),
      getCVDDataSince: jest.fn(),
      saveAlertHistory: jest.fn(),
      getRecentAlerts: jest.fn(),
      saveOrderFlowRatioData: jest.fn().mockResolvedValue(undefined),
      saveSkewRawData: jest.fn().mockResolvedValue(undefined),
      closeDatabase: jest.fn(),
    } as unknown as jest.Mocked<IDatabaseManager>;

    collector = new DeribitAnalyticsCollector(mockDatabaseManager, {
      apiUrl: 'https://test.deribit.com/api/v2',
      intervalMs: 60000,
      instrumentRefreshIntervalMs: 3600000,
      ratioPriceWindowUsd: 5,
      maxConcurrentRequests: 1,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should classify instruments and build selection by delta bucket', async () => {
    const now = Date.now();
    const frontExpiry = now + 7 * 24 * 60 * 60 * 1000;

    const instruments = [
      {
        instrument_name: 'BTC-FRONT-25000-C',
        expiration_timestamp: frontExpiry,
        option_type: 'call' as const,
        settlement_period: 'month',
        is_active: true,
      },
      {
        instrument_name: 'BTC-FRONT-25000-P',
        expiration_timestamp: frontExpiry,
        option_type: 'put' as const,
        settlement_period: 'month',
        is_active: true,
      },
    ];

    const tickerMap: Record<string, number> = {
      'BTC-FRONT-25000-C': 0.24,
      'BTC-FRONT-25000-P': -0.26,
    };

    const internalCollector = collector as any;

    const makeRequestSpy = jest
      .spyOn(internalCollector, 'makeRequest')
      .mockImplementation(async (...args: any[]) => {
        const [endpoint, params] = args as [string, Record<string, unknown>];
        if (endpoint === '/public/get_instruments') {
          return { result: instruments };
        }

        if (endpoint === '/public/ticker') {
          const instrumentName = params['instrument_name'] as string;
          return { result: { greeks: { delta: tickerMap[instrumentName] } } };
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      });

    const refreshed = await internalCollector.refreshInstruments();

    expect(refreshed).toBe(true);
    expect(makeRequestSpy).toHaveBeenCalledWith('/public/get_instruments', expect.any(Object));

    const selection = collector.getInstrumentSelection();
    expect(selection.Front?.['25D']?.call?.instrument.instrument_name).toBe('BTC-FRONT-25000-C');
    expect(selection.Front?.['25D']?.put?.instrument.instrument_name).toBe('BTC-FRONT-25000-P');
  });

  it('should compute ratio and persist skew raw data', async () => {
    const now = Date.now();
    const frontExpiry = now + 7 * 24 * 60 * 60 * 1000;

    const instruments = [
      {
        instrument_name: 'BTC-FRONT-25000-C',
        expiration_timestamp: frontExpiry,
        option_type: 'call' as const,
        settlement_period: 'month',
        is_active: true,
      },
      {
        instrument_name: 'BTC-FRONT-25000-P',
        expiration_timestamp: frontExpiry,
        option_type: 'put' as const,
        settlement_period: 'month',
        is_active: true,
      },
    ];

    const tickerMap: Record<string, number> = {
      'BTC-FRONT-25000-C': 0.24,
      'BTC-FRONT-25000-P': -0.26,
    };

    const orderBookMap = {
      'BTC-FRONT-25000-C': {
        timestamp: 1700000000000,
        instrument_name: 'BTC-FRONT-25000-C',
        index_price: 100000,
        mark_price: 0.105,
        mark_iv: 0.5,
        best_bid_price: 0.1,
        best_ask_price: 0.11,
        bids: [
          [0.1, 2],
          [0.09998, 3],
          [0.0997, 1],
        ],
        asks: [
          [0.11, 1],
          [0.11003, 4],
          [0.1105, 1],
        ],
        greeks: {
          delta: 0.24,
        },
      },
      'BTC-FRONT-25000-P': {
        timestamp: 1700000005000,
        instrument_name: 'BTC-FRONT-25000-P',
        index_price: 100000,
        mark_price: 0.205,
        mark_iv: 0.6,
        best_bid_price: 0.2,
        best_ask_price: 0.21,
        bids: [
          [0.2, 6],
          [0.19997, 3],
          [0.1995, 1],
        ],
        asks: [
          [0.21, 3],
          [0.20997, 1.5],
          [0.2106, 1],
        ],
        greeks: {
          delta: -0.26,
        },
      },
    } as const;

    const internalCollector = collector as any;

    jest
      .spyOn(internalCollector, 'makeRequest')
      .mockImplementation(async (...args: any[]) => {
        const [endpoint, params] = args as [string, Record<string, unknown>];
        if (endpoint === '/public/get_instruments') {
          return { result: instruments };
        }

        if (endpoint === '/public/ticker') {
          const instrumentName = params['instrument_name'] as string;
          return { result: { greeks: { delta: tickerMap[instrumentName] } } };
        }

        if (endpoint === '/public/get_order_book') {
          const instrumentName = params['instrument_name'] as keyof typeof orderBookMap;
          return { result: orderBookMap[instrumentName] };
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      });

    await internalCollector.refreshInstruments();
    await internalCollector.collectOnce();

    expect(mockDatabaseManager.saveOrderFlowRatioData).toHaveBeenCalledTimes(1);
    const ratioPayload = mockDatabaseManager.saveOrderFlowRatioData.mock.calls[0]?.[0] as any[];
    expect(ratioPayload).toBeDefined();
    const targetRatioRows = ratioPayload.filter((row) => row.deltaBucket === '25D');
    expect(targetRatioRows).toHaveLength(2);
    const ratioCallRow = targetRatioRows.find((row) => row.optionType === 'call');
    const ratioPutRow = targetRatioRows.find((row) => row.optionType === 'put');
    expect(ratioCallRow).toMatchObject({
      expiryType: 'Front',
      expiryTimestamp: frontExpiry,
      deltaBucket: '25D',
      optionType: 'call',
    });
    expect(ratioCallRow?.ratio).toBeCloseTo(1, 5);

    expect(ratioPutRow).toMatchObject({
      expiryType: 'Front',
      expiryTimestamp: frontExpiry,
      deltaBucket: '25D',
      optionType: 'put',
    });
    expect(ratioPutRow?.ratio).toBeCloseTo(2, 5);

    expect(mockDatabaseManager.saveSkewRawData).toHaveBeenCalledTimes(1);
    const skewPayload = mockDatabaseManager.saveSkewRawData.mock.calls[0]?.[0] as any[];
    expect(skewPayload).toBeDefined();
    const targetSkewRows = skewPayload.filter((row) => row.deltaBucket === '25D');
    expect(targetSkewRows).toHaveLength(2);
    const skewCallRow = targetSkewRows.find((row) => row.optionType === 'call');
    const skewPutRow = targetSkewRows.find((row) => row.optionType === 'put');
    expect(skewCallRow).toMatchObject({
      expiryType: 'Front',
      expiryTimestamp: frontExpiry,
      deltaBucket: '25D',
      optionType: 'call',
      markIv: 0.5,
      markPrice: 0.105,
      delta: 0.24,
      indexPrice: 100000,
    });
    expect(skewPutRow).toMatchObject({
      expiryType: 'Front',
      expiryTimestamp: frontExpiry,
      deltaBucket: '25D',
      optionType: 'put',
      markIv: 0.6,
      markPrice: 0.205,
      delta: -0.26,
      indexPrice: 100000,
    });
  });
});
