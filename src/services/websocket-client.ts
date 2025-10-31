/**
 * WebSocket client for Deribit API
 * Handles real-time trade data collection with auto-reconnection
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { TradeData } from '../types';

export interface DeribitTradePayload {
  trade_seq?: number;
  trade_id?: string;
  block_trade_id?: string;
  timestamp: number;
  tick_direction?: number;
  price?: number;
  mark_price?: number;
  instrument_name?: string;
  index_price?: number;
  direction?: string;
  amount?: number;
  quantity?: number;
  contracts?: number;
  iv?: number;
  underlying_price?: number;
}

export interface DeribitTradeMessage {
  jsonrpc: string;
  method: string;
  params: {
    channel: string;
    data: DeribitTradePayload[];
  };
}

export interface WebSocketClientOptions {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
}

/**
 * WebSocket client for Deribit API with auto-reconnection
 */
export class DeribitWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<WebSocketClientOptions>;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private subscriptions: string[] = [];
  private lastActivity = Date.now();

  constructor(options: WebSocketClientOptions) {
    super();
    
    const heartbeatInterval = options.heartbeatInterval ?? 30000;

    this.options = {
      url: options.url,
      reconnectInterval: options.reconnectInterval ?? 5000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY,
      heartbeatInterval,
      heartbeatTimeout: options.heartbeatTimeout ?? heartbeatInterval * 3,
    };
  }

  /**
   * Connect to Deribit WebSocket API
   */
  async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    try {
      console.log(`Connecting to Deribit WebSocket: ${this.options.url}`);
      
      this.ws = new WebSocket(this.options.url);
      this.lastActivity = Date.now();
      
      this.ws.on('open', this.onOpen.bind(this));
      this.ws.on('message', this.onMessage.bind(this));
      this.ws.on('close', this.onClose.bind(this));
      this.ws.on('error', this.onError.bind(this));
      this.ws.on('pong', this.onPong.bind(this));

      // Wait for connection to be established
      await new Promise<void>((resolve, reject) => {
        let timeout: NodeJS.Timeout | null = null;

        const cleanup = (): void => {
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          this.off('connected', handleConnected);
          this.off('error', handleError);
        };

        const handleConnected = (): void => {
          cleanup();
          resolve();
        };

        const handleError = (error: Error): void => {
          cleanup();
          reject(error);
        };

        timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Connection timeout'));
        }, 10000);

        this.once('connected', handleConnected);
        this.once('error', handleError);
      });

    } catch (error) {
      this.isConnecting = false;
      throw error;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.shouldReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnecting = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Subscribe to BTC trade data channels
   */
  async subscribeToBTCTrades(): Promise<void> {
    const btcChannels = [
      'trades.BTC-PERPETUAL.100ms',
      'trades.BTC-PERPETUAL-USDC.100ms',
      'trades.BTC-USD.100ms',
      'trades.option.BTC.raw',
      'block_trade.BTC'
    ];

    for (const channel of btcChannels) {
      await this.subscribe(channel);
    }
  }

  /**
   * Subscribe to a specific channel
   */
  private async subscribe(channel: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const subscribeMessage = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'public/subscribe',
      params: {
        channels: [channel]
      }
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    if (!this.subscriptions.includes(channel)) {
      this.subscriptions.push(channel);
    }
    
    console.log(`Subscribed to channel: ${channel}`);
  }

  /**
   * Handle WebSocket open event
   */
  private onOpen(): void {
    console.log('WebSocket connected to Deribit');
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.lastActivity = Date.now();
    
    // Start heartbeat
    this.startHeartbeat();
    
    // Re-subscribe to channels if this is a reconnection
    if (this.subscriptions.length > 0) {
      this.resubscribe();
    }
    
    this.emit('connected');
  }

  /**
   * Handle WebSocket message event
   */
  private onMessage(data: WebSocket.Data): void {
    this.lastActivity = Date.now();

    try {
      const message = JSON.parse(data.toString()) as DeribitTradeMessage;
      
      // Handle subscription confirmations
      if (message.jsonrpc && !message.method) {
        return; // Subscription response
      }

      // Handle trade data
      if (message.method === 'subscription' && message.params?.data) {
        const tradeData = this.parseTradeData(message);
        if (tradeData.length > 0) {
          this.emit('tradeData', tradeData);
        }
      }

    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle WebSocket close event
   */
  private onClose(code: number, reason: Buffer): void {
    console.log(`WebSocket closed: ${code} - ${reason.toString()}`);
    
    this.isConnecting = false;
    this.lastActivity = Date.now();
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.emit('disconnected', { code, reason: reason.toString() });

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket error event
   */
  private onError(error: Error): void {
    console.error('WebSocket error:', error);
    this.isConnecting = false;
    this.emit('error', error);
  }

  /**
   * Handle WebSocket pong responses
   */
  private onPong(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const maxAttempts = this.options.maxReconnectAttempts;
    const hasLimit = Number.isFinite(maxAttempts);

    this.reconnectAttempts++;

    if (hasLimit && this.reconnectAttempts > maxAttempts) {
      console.error('Max reconnection attempts reached');
      this.shouldReconnect = false;
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    const delay = Math.min(
      this.options.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
      30000 // Max 30 seconds
    );

    console.log(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      
      try {
        await this.connect();
      } catch (error) {
        console.error('Reconnection failed:', error);
        // The onClose handler will schedule the next attempt
      }
    }, delay);
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      const socket = this.ws;

      if (!socket) {
        return;
      }

      if (socket.readyState === WebSocket.OPEN) {
        const heartbeat = {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'public/ping'
        };
        
        try {
          socket.send(JSON.stringify(heartbeat));
        } catch (error) {
          console.error('Failed to send heartbeat message:', error);
        }

        try {
          socket.ping();
        } catch {
          // Ignore if ping frames are not supported by the remote endpoint
        }
      }

      const idleTime = Date.now() - this.lastActivity;
      if (idleTime > this.options.heartbeatTimeout && socket.readyState === WebSocket.OPEN) {
        console.warn(`Heartbeat timeout exceeded (${idleTime}ms), terminating WebSocket`);
        socket.terminate();
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * Re-subscribe to all channels after reconnection
   */
  private async resubscribe(): Promise<void> {
    const channels = [...this.subscriptions];
    this.subscriptions = [];
    
    for (const channel of channels) {
      try {
        await this.subscribe(channel);
      } catch (error) {
        console.error(`Failed to resubscribe to ${channel}:`, error);
      }
    }
  }

  /**
   * Parse trade data from Deribit message format
   */
  private parseTradeData(message: DeribitTradeMessage): TradeData[] {
    const trades: TradeData[] = [];

    if (!message.params?.data) {
      return trades;
    }

    const channel = message.params.channel;

    for (const trade of message.params.data) {
      try {
        const tradeId = trade.trade_id ?? trade.block_trade_id;
        if (!tradeId) {
          throw new Error('Missing trade identifier');
        }

        if (!trade.instrument_name) {
          throw new Error('Missing instrument name');
        }

        const price = typeof trade.price === 'number' ? trade.price : trade.mark_price;
        if (typeof price !== 'number' || price <= 0) {
          throw new Error(`Invalid price value: ${price}`);
        }

        const directionRaw = trade.direction?.toLowerCase();
        const direction = directionRaw?.includes('sell')
          ? 'sell'
          : directionRaw?.includes('buy')
            ? 'buy'
            : undefined;

        if (!direction) {
          throw new Error(`Invalid direction value: ${trade.direction}`);
        }

        const timestamp = trade.timestamp;
        if (typeof timestamp !== 'number') {
          throw new Error(`Invalid timestamp value: ${timestamp}`);
        }

        const amount = this.normalizeTradeAmount(trade, channel);

        const tradeData: TradeData = {
          symbol: trade.instrument_name,
          timestamp,
          price,
          amount,
          direction,
          tradeId,
          channel,
          isBlockTrade: channel?.startsWith('block_trade.') ?? false,
        };

        if (typeof trade.mark_price === 'number') {
          tradeData.markPrice = trade.mark_price;
        }

        if (typeof trade.index_price === 'number') {
          tradeData.indexPrice = trade.index_price;
        }

        if (typeof trade.underlying_price === 'number') {
          tradeData.underlyingPrice = trade.underlying_price;
        }

        if (typeof trade.iv === 'number') {
          tradeData.iv = trade.iv;
        }

        trades.push(tradeData);
      } catch (error) {
        console.error('Error parsing individual trade:', error, trade);
      }
    }

    return trades;
  }

  private normalizeTradeAmount(
    trade: DeribitTradeMessage['params']['data'][number],
    channel?: string
  ): number {
    let rawAmount: number | undefined;
    if (typeof trade.amount === 'number' && Number.isFinite(trade.amount)) {
      rawAmount = trade.amount;
    } else if (typeof trade.quantity === 'number' && Number.isFinite(trade.quantity)) {
      rawAmount = trade.quantity;
    } else if (typeof trade.contracts === 'number' && Number.isFinite(trade.contracts)) {
      rawAmount = trade.contracts;
    }

    if (rawAmount === undefined || rawAmount <= 0) {
      throw new Error(`Invalid amount value: ${rawAmount}`);
    }

    const symbol = trade.instrument_name ?? '';
    if (!symbol) {
      return rawAmount;
    }

    if (channel?.startsWith('block_trade.')) {
      return rawAmount;
    }

    if (symbol.includes('PERPETUAL') || symbol.endsWith('-PERP') || symbol.endsWith('-USD')) {
      const price =
        typeof trade.price === 'number' && trade.price > 0
          ? trade.price
          : typeof trade.mark_price === 'number' && trade.mark_price > 0
            ? trade.mark_price
            : undefined;

      if (price !== undefined) {
        return rawAmount / price;
      }
    }

    return rawAmount;
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get current subscriptions
   */
  getSubscriptions(): string[] {
    return [...this.subscriptions];
  }
}
