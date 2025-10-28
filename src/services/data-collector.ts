/**
 * Data collection service that integrates WebSocket and REST API clients
 * Handles data validation, formatting, and database storage
 */

import { EventEmitter } from 'events';
import { TradeData, OptionData } from '../types';
import { IDataCollector, IDatabaseManager } from './interfaces';
import { DeribitWebSocketClient } from './websocket-client';
import { DeribitRestClient } from './rest-client';

export interface DataCollectorOptions {
  websocketUrl: string;
  restApiUrl?: string;
  optionDataInterval?: number;
  enableTradeCollection?: boolean;
  enableOptionCollection?: boolean;
}

/**
 * Main data collection service
 */
export class DataCollector extends EventEmitter implements IDataCollector {
  private wsClient: DeribitWebSocketClient;
  private restClient: DeribitRestClient;
  private databaseManager: IDatabaseManager;
  private options: Required<DataCollectorOptions>;
  private isRunning = false;
  private tradeDataBuffer: TradeData[] = [];
  private optionDataBuffer: OptionData[] = [];
  private bufferFlushInterval: NodeJS.Timeout | null = null;
  private readonly BUFFER_FLUSH_INTERVAL = 5000; // 5 seconds
  private readonly MAX_BUFFER_SIZE = 1000;
  private readonly BLOCK_TRADE_ALERT_THRESHOLD = 1000;
  private isFlushingTrades = false;
  private isFlushingOptions = false;
  private tradeRestartPromise: Promise<void> | null = null;
  private optionRestartPromise: Promise<void> | null = null;
  private systemRecoveryPromise: Promise<void> | null = null;

  constructor(
    databaseManager: IDatabaseManager,
    options: DataCollectorOptions
  ) {
    super();

    this.databaseManager = databaseManager;
    
    this.options = {
      websocketUrl: options.websocketUrl,
      restApiUrl: options.restApiUrl || 'https://www.deribit.com/api/v2',
      optionDataInterval: options.optionDataInterval || 3600000, // 1 hour
      enableTradeCollection: options.enableTradeCollection ?? true,
      enableOptionCollection: options.enableOptionCollection ?? true,
    };

    // Initialize WebSocket client
    this.wsClient = new DeribitWebSocketClient({
      url: this.options.websocketUrl,
      reconnectInterval: 5000,
      maxReconnectAttempts: Number.POSITIVE_INFINITY,
      heartbeatInterval: 30000,
      heartbeatTimeout: 90000,
    });

    // Initialize REST client
    this.restClient = new DeribitRestClient({
      baseUrl: this.options.restApiUrl,
      timeout: 10000,
      maxRetries: 3,
      retryDelay: 1000,
      intervalMs: this.options.optionDataInterval,
    });

    this.setupEventHandlers();
  }

  /**
   * Start trade data collection via WebSocket
   */
  async startTradeDataCollection(): Promise<void> {
    if (!this.options.enableTradeCollection) {
      console.log('Trade data collection is disabled');
      return;
    }

    try {
      console.log('Starting trade data collection...');
      
      await this.wsClient.connect();
      await this.wsClient.subscribeToBTCTrades();
      
      console.log('Trade data collection started successfully');
      this.emit('tradeCollectionStarted');

    } catch (error) {
      console.error('Failed to start trade data collection:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Start option data collection via REST API
   */
  async startOptionDataCollection(): Promise<void> {
    if (!this.options.enableOptionCollection) {
      console.log('Option data collection is disabled');
      return;
    }

    try {
      console.log('Starting option data collection...');
      
      // Test API connectivity first
      const isConnected = await this.restClient.testConnection();
      if (!isConnected) {
        throw new Error('Failed to connect to Deribit REST API');
      }

      this.restClient.startPeriodicCollection();
      
      console.log('Option data collection started successfully');
      this.emit('optionCollectionStarted');

    } catch (error) {
      console.error('Failed to start option data collection:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop all data collection processes
   */
  async stopCollection(): Promise<void> {
    console.log('Stopping data collection...');
    
    this.isRunning = false;

    // Stop WebSocket client
    this.wsClient.disconnect();

    // Stop REST client
    this.restClient.stopPeriodicCollection();

    // Stop buffer flushing
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }

    // Flush remaining data in buffers
    await this.flushBuffers();

    console.log('Data collection stopped');
    this.emit('collectionStopped');
  }

  /**
   * Start the complete data collection system
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Data collector is already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting data collector...');

    try {
      // Start buffer flushing
      this.startBufferFlushing();

      // Start both collection methods
      const promises: Promise<void>[] = [];
      
      if (this.options.enableTradeCollection) {
        promises.push(this.startTradeDataCollection());
      }
      
      if (this.options.enableOptionCollection) {
        promises.push(this.startOptionDataCollection());
      }

      await Promise.all(promises);

      console.log('Data collector started successfully');
      this.emit('started');

    } catch (error) {
      this.isRunning = false;
      console.error('Failed to start data collector:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Setup event handlers for WebSocket and REST clients
   */
  private setupEventHandlers(): void {
    // WebSocket event handlers
    this.wsClient.on('tradeData', (trades: TradeData[]) => {
      this.handleTradeData(trades);
    });

    this.wsClient.on('connected', () => {
      console.log('WebSocket connected');
      this.emit('websocketConnected');
    });

    this.wsClient.on('disconnected', (info) => {
      console.log('WebSocket disconnected:', info);
      this.emit('websocketDisconnected', info);
    });

    this.wsClient.on('maxReconnectAttemptsReached', () => {
      console.error('WebSocket reached maximum reconnection attempts, initiating restart');
      this.restartTradeDataCollection('max reconnect attempts reached').catch((error) => {
        console.error('Failed to restart trade data collection after reaching max attempts', error);
        this.emit('error', error);
      });
    });

    this.wsClient.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.emit('websocketError', error);
    });

    // REST client event handlers
    this.restClient.on('optionData', (options: OptionData[]) => {
      this.handleOptionData(options);
    });

    this.restClient.on('error', (error) => {
      console.error('REST client error:', error);
      this.emit('restError', error);
    });

    this.restClient.on('periodicCollectionStarted', () => {
      console.log('Periodic option data collection started');
    });

    this.restClient.on('periodicCollectionStopped', () => {
      console.log('Periodic option data collection stopped');
    });
  }

  /**
   * Handle incoming trade data
   */
  private handleTradeData(trades: TradeData[]): void {
    try {
      // Validate and filter trade data
      const validTrades = this.validateTradeData(trades);
      
      if (validTrades.length === 0) {
        return;
      }

      // Add to buffer
      this.tradeDataBuffer.push(...validTrades);
      
      console.log(`Received ${validTrades.length} valid trades, buffer size: ${this.tradeDataBuffer.length}`);
      
      // Emit event for real-time processing
      this.emit('tradeDataReceived', validTrades);

      const largeBlockTrades = validTrades.filter(
        (trade) => trade.isBlockTrade && trade.amount > this.BLOCK_TRADE_ALERT_THRESHOLD
      );

      if (largeBlockTrades.length > 0) {
        this.emit('blockTradeThresholdExceeded', largeBlockTrades);
      }

      // Flush buffer if it's getting too large
      if (this.tradeDataBuffer.length >= this.MAX_BUFFER_SIZE) {
        this.flushTradeDataBuffer();
      }

    } catch (error) {
      console.error('Error handling trade data:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle incoming option data
   */
  private handleOptionData(options: OptionData[]): void {
    try {
      // Validate and filter option data
      const validOptions = this.validateOptionData(options);
      
      if (validOptions.length === 0) {
        return;
      }

      // Add to buffer
      this.optionDataBuffer.push(...validOptions);
      
      console.log(`Received ${validOptions.length} valid options, buffer size: ${this.optionDataBuffer.length}`);
      
      // Emit event for real-time processing
      this.emit('optionDataReceived', validOptions);

      // Flush buffer if it's getting too large
      if (this.optionDataBuffer.length >= this.MAX_BUFFER_SIZE) {
        this.flushOptionDataBuffer();
      }

    } catch (error) {
      console.error('Error handling option data:', error);
      this.emit('error', error);
    }
  }

  /**
   * Validate trade data
   */
  private validateTradeData(trades: TradeData[]): TradeData[] {
    return trades.filter(trade => {
      // Check required fields
      if (!trade.symbol || !trade.tradeId || !trade.timestamp) {
        console.warn('Invalid trade data: missing required fields', trade);
        return false;
      }

      // Check numeric values
      if (typeof trade.price !== 'number' || trade.price <= 0) {
        console.warn('Invalid trade data: invalid price', trade);
        return false;
      }

      if (typeof trade.amount !== 'number' || trade.amount <= 0) {
        console.warn('Invalid trade data: invalid amount', trade);
        return false;
      }

      // Check direction
      if (!['buy', 'sell'].includes(trade.direction)) {
        console.warn('Invalid trade data: invalid direction', trade);
        return false;
      }

      // Check timestamp (should be within reasonable range)
      const now = Date.now();
      if (trade.timestamp > now + 60000 || trade.timestamp < now - 86400000) {
        console.warn('Invalid trade data: timestamp out of range', trade);
        return false;
      }

      return true;
    });
  }

  /**
   * Validate option data
   */
  private validateOptionData(options: OptionData[]): OptionData[] {
    return options.filter(option => {
      // Check required fields
      if (!option.symbol || !option.timestamp) {
        console.warn('Invalid option data: missing required fields', option);
        return false;
      }

      // Check numeric values
      if (typeof option.underlyingPrice !== 'number' || option.underlyingPrice <= 0) {
        console.warn('Invalid option data: invalid underlying price', option);
        return false;
      }

      if (typeof option.markPrice !== 'number' || option.markPrice < 0) {
        console.warn('Invalid option data: invalid mark price', option);
        return false;
      }

      // Check Greeks (should be numbers)
      const greeks = ['delta', 'gamma', 'theta', 'vega', 'rho'];
      for (const greek of greeks) {
        if (typeof option[greek as keyof OptionData] !== 'number') {
          console.warn(`Invalid option data: invalid ${greek}`, option);
          return false;
        }
      }

      // Check timestamp
      const now = Date.now();
      if (option.timestamp > now + 60000 || option.timestamp < now - 86400000) {
        console.warn('Invalid option data: timestamp out of range', option);
        return false;
      }

      return true;
    });
  }

  /**
   * Start periodic buffer flushing
   */
  private startBufferFlushing(): void {
    if (this.bufferFlushInterval) {
      return;
    }

    this.bufferFlushInterval = setInterval(() => {
      this.flushBuffers();
    }, this.BUFFER_FLUSH_INTERVAL);
  }

  /**
   * Flush all buffers to database
   */
  private async flushBuffers(): Promise<void> {
    await this.flushTradeDataBuffer();
    await this.flushOptionDataBuffer();
  }

  /**
   * Flush trade data buffer to database
   */
  private async flushTradeDataBuffer(): Promise<void> {
    if (this.tradeDataBuffer.length === 0 || this.isFlushingTrades) {
      return;
    }

    this.isFlushingTrades = true;

    const trades = [...this.tradeDataBuffer];
    this.tradeDataBuffer = [];

    try {
      await this.databaseManager.saveTradeData(trades);
      console.log(`Saved ${trades.length} trades to database`);
      this.emit('tradeDataSaved', trades.length);
    } catch (error) {
      console.error('Failed to save trade data:', error);
      // Put data back in buffer for retry
      this.tradeDataBuffer.unshift(...trades);
      this.emit('error', error);
    } finally {
      this.isFlushingTrades = false;
    }
  }

  /**
   * Flush option data buffer to database
   */
  private async flushOptionDataBuffer(): Promise<void> {
    if (this.optionDataBuffer.length === 0 || this.isFlushingOptions) {
      return;
    }

    this.isFlushingOptions = true;

    const options = [...this.optionDataBuffer];
    this.optionDataBuffer = [];

    try {
      await this.databaseManager.saveOptionData(options);
      console.log(`Saved ${options.length} options to database`);
      this.emit('optionDataSaved', options.length);
    } catch (error) {
      console.error('Failed to save option data:', error);
      // Put data back in buffer for retry
      this.optionDataBuffer.unshift(...options);
      this.emit('error', error);
    } finally {
      this.isFlushingOptions = false;
    }
  }

  /**
   * Restart trade data collection with optional context
   */
  async restartTradeDataCollection(reason?: string): Promise<void> {
    if (!this.options.enableTradeCollection) {
      return;
    }

    if (this.tradeRestartPromise) {
      return this.tradeRestartPromise;
    }

    this.tradeRestartPromise = this.performTradeRestart(reason).finally(() => {
      this.tradeRestartPromise = null;
    });

    return this.tradeRestartPromise;
  }

  /**
   * Restart option data collection with optional context
   */
  async restartOptionDataCollection(reason?: string): Promise<void> {
    if (!this.options.enableOptionCollection) {
      return;
    }

    if (this.optionRestartPromise) {
      return this.optionRestartPromise;
    }

    this.optionRestartPromise = this.performOptionRestart(reason).finally(() => {
      this.optionRestartPromise = null;
    });

    return this.optionRestartPromise;
  }

  /**
   * Attempt to recover collectors after detecting system suspension/resume
   */
  async recoverFromSystemResume(): Promise<void> {
    if (!this.isRunning) {
      console.log('System resume detected but data collector is not running');
      return;
    }

    if (this.systemRecoveryPromise) {
      return this.systemRecoveryPromise;
    }

    const tasks: Promise<void>[] = [];

    if (this.options.enableTradeCollection) {
      tasks.push(this.restartTradeDataCollection('system resume detected'));
    }

    if (this.options.enableOptionCollection) {
      tasks.push(this.restartOptionDataCollection('system resume detected'));
    }

    this.systemRecoveryPromise = Promise.all(tasks)
      .then(() => {
        console.log('Recovery after system resume completed');
      })
      .catch((error) => {
        console.error('Failed to recover after system resume:', error);
        this.emit('error', error);
        throw error;
      })
      .finally(() => {
        this.systemRecoveryPromise = null;
      });

    return this.systemRecoveryPromise;
  }

  /**
   * Internal helper to restart trade collection
   */
  private async performTradeRestart(reason?: string): Promise<void> {
    const prefix = reason ? `Restarting trade data collection (${reason})` : 'Restarting trade data collection...';
    console.log(prefix);

    try {
      this.wsClient.disconnect();
      await this.wsClient.connect();

      if (this.wsClient.getSubscriptions().length === 0) {
        await this.wsClient.subscribeToBTCTrades();
      }

      console.log('Trade data collection restarted successfully');
      this.emit('tradeCollectionRestarted');
    } catch (error) {
      console.error('Failed to restart trade data collection:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Internal helper to restart option collection
   */
  private async performOptionRestart(reason?: string): Promise<void> {
    const prefix = reason ? `Restarting option data collection (${reason})` : 'Restarting option data collection...';
    console.log(prefix);

    try {
      this.restClient.stopPeriodicCollection();
      await this.restClient.collectOptionData();
      this.restClient.startPeriodicCollection();

      console.log('Option data collection restarted successfully');
      this.emit('optionCollectionRestarted');
    } catch (error) {
      console.error('Failed to restart option data collection:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get collection status
   */
  getStatus(): {
    isRunning: boolean;
    websocketConnected: boolean;
    restClientRunning: boolean;
    tradeBufferSize: number;
    optionBufferSize: number;
  } {
    return {
      isRunning: this.isRunning,
      websocketConnected: this.wsClient.isConnected(),
      restClientRunning: this.restClient.isCollecting(),
      tradeBufferSize: this.tradeDataBuffer.length,
      optionBufferSize: this.optionDataBuffer.length,
    };
  }

  /**
   * Force flush buffers (for testing or manual operations)
   */
  async forceFlush(): Promise<void> {
    await this.flushBuffers();
  }

  /**
   * Get buffer sizes
   */
  getBufferSizes(): { trades: number; options: number } {
    return {
      trades: this.tradeDataBuffer.length,
      options: this.optionDataBuffer.length,
    };
  }
}
