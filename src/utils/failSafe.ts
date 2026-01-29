/**
 * Fail-Safe Utility
 *
 * Provides circuit breaker patterns, RPC fail-over,
 * and kill switch functionality for safe operation.
 */

import { Connection } from '@solana/web3.js';
import { config } from '../config';
import logger from './logger';
import db from '../database';

// Circuit breaker states
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerConfig {
  failureThreshold: number;    // Failures before opening circuit
  successThreshold: number;    // Successes in half-open to close
  timeoutMs: number;           // Time before trying half-open
  name: string;
}

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number;
  lastStateChange: number;
}

// Default RPC endpoints for fail-over
const DEFAULT_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
];

class FailSafe {
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private configs: Map<string, CircuitBreakerConfig> = new Map();
  private killSwitch: boolean = false;
  private killSwitchReason: string = '';
  private rpcEndpoints: string[] = [];
  private currentRpcIndex: number = 0;
  private rpcConnections: Map<string, Connection> = new Map();

  constructor() {
    // Initialize RPC endpoints
    this.rpcEndpoints = [config.solana.rpcUrl, ...DEFAULT_RPC_ENDPOINTS];
    this.rpcEndpoints = [...new Set(this.rpcEndpoints)]; // Remove duplicates

    // Default circuit breaker configs
    this.setConfig('rpc', { name: 'Solana RPC', failureThreshold: 5, successThreshold: 3, timeoutMs: 30000 });
    this.setConfig('dexscreener', { name: 'DexScreener API', failureThreshold: 3, successThreshold: 2, timeoutMs: 60000 });
    this.setConfig('jupiter', { name: 'Jupiter API', failureThreshold: 3, successThreshold: 2, timeoutMs: 30000 });
    this.setConfig('helius', { name: 'Helius API', failureThreshold: 5, successThreshold: 2, timeoutMs: 60000 });
    this.setConfig('birdeye', { name: 'Birdeye API', failureThreshold: 3, successThreshold: 2, timeoutMs: 60000 });
    this.setConfig('trading', { name: 'Trading Engine', failureThreshold: 3, successThreshold: 2, timeoutMs: 120000 });
  }

  // ============================================================
  // KILL SWITCH
  // ============================================================

  /**
   * Activate the kill switch - stops all trading operations
   */
  activateKillSwitch(reason: string): void {
    this.killSwitch = true;
    this.killSwitchReason = reason;

    logger.error(`🚨 KILL SWITCH ACTIVATED: ${reason}`);

    // Log to database
    db.saveSystemLog('critical', 'kill_switch', `Kill switch activated: ${reason}`);

    // Disable auto-trading for all users
    this.disableAllAutoTrading();
  }

  /**
   * Deactivate the kill switch
   */
  deactivateKillSwitch(): void {
    if (!this.killSwitch) return;

    this.killSwitch = false;
    const previousReason = this.killSwitchReason;
    this.killSwitchReason = '';

    logger.info(`✅ Kill switch deactivated (was: ${previousReason})`);
    db.saveSystemLog('info', 'kill_switch', `Kill switch deactivated (was: ${previousReason})`);
  }

  /**
   * Check if kill switch is active
   */
  isKillSwitchActive(): boolean {
    return this.killSwitch;
  }

  /**
   * Get kill switch reason
   */
  getKillSwitchReason(): string {
    return this.killSwitchReason;
  }

  /**
   * Disable auto-trading for all users (emergency measure)
   */
  private disableAllAutoTrading(): void {
    try {
      const autoTradeUsers = db.getUsersWithAutoTrade();
      for (const user of autoTradeUsers) {
        db.updateUserSettings(user.userId, { autoTrade: false });
        logger.info(`Disabled auto-trade for user ${user.userId} due to kill switch`);
      }
    } catch (error) {
      logger.error('Error disabling auto-trading:', error);
    }
  }

  // ============================================================
  // CIRCUIT BREAKER
  // ============================================================

  /**
   * Set circuit breaker config
   */
  setConfig(key: string, config: CircuitBreakerConfig): void {
    this.configs.set(key, config);
    this.circuitBreakers.set(key, {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailure: 0,
      lastStateChange: Date.now(),
    });
  }

  /**
   * Check if circuit is open (should not make request)
   */
  isCircuitOpen(key: string): boolean {
    const state = this.circuitBreakers.get(key);
    const config = this.configs.get(key);

    if (!state || !config) return false;

    // Check if we should transition from open to half-open
    if (state.state === 'open') {
      const now = Date.now();
      if (now - state.lastStateChange > config.timeoutMs) {
        state.state = 'half-open';
        state.lastStateChange = now;
        state.successes = 0;
        logger.info(`Circuit breaker ${config.name}: OPEN -> HALF-OPEN`);
      }
    }

    return state.state === 'open';
  }

  /**
   * Record a successful operation
   */
  recordSuccess(key: string): void {
    const state = this.circuitBreakers.get(key);
    const config = this.configs.get(key);

    if (!state || !config) return;

    if (state.state === 'half-open') {
      state.successes++;

      if (state.successes >= config.successThreshold) {
        state.state = 'closed';
        state.failures = 0;
        state.successes = 0;
        state.lastStateChange = Date.now();
        logger.info(`Circuit breaker ${config.name}: HALF-OPEN -> CLOSED (recovered)`);
      }
    } else if (state.state === 'closed') {
      // Reset failure count on success
      state.failures = Math.max(0, state.failures - 1);
    }
  }

  /**
   * Record a failed operation
   */
  recordFailure(key: string, error?: Error): void {
    const state = this.circuitBreakers.get(key);
    const config = this.configs.get(key);

    if (!state || !config) return;

    state.failures++;
    state.lastFailure = Date.now();

    if (state.state === 'half-open') {
      // Any failure in half-open goes back to open
      state.state = 'open';
      state.lastStateChange = Date.now();
      logger.warn(`Circuit breaker ${config.name}: HALF-OPEN -> OPEN (failure: ${error?.message || 'unknown'})`);
    } else if (state.state === 'closed' && state.failures >= config.failureThreshold) {
      state.state = 'open';
      state.lastStateChange = Date.now();
      logger.warn(`Circuit breaker ${config.name}: CLOSED -> OPEN (${state.failures} failures)`);
      db.saveSystemLog('warning', 'circuit_breaker', `${config.name} circuit opened after ${state.failures} failures`);
    }
  }

  /**
   * Get circuit breaker status
   */
  getCircuitStatus(key: string): { state: CircuitState; failures: number; lastFailure: Date | null } | null {
    const state = this.circuitBreakers.get(key);
    if (!state) return null;

    return {
      state: state.state,
      failures: state.failures,
      lastFailure: state.lastFailure > 0 ? new Date(state.lastFailure) : null,
    };
  }

  /**
   * Reset circuit breaker
   */
  resetCircuit(key: string): void {
    const state = this.circuitBreakers.get(key);
    const config = this.configs.get(key);

    if (!state || !config) return;

    state.state = 'closed';
    state.failures = 0;
    state.successes = 0;
    state.lastStateChange = Date.now();

    logger.info(`Circuit breaker ${config.name}: manually reset to CLOSED`);
  }

  // ============================================================
  // RPC FAIL-OVER
  // ============================================================

  /**
   * Get a working RPC connection with automatic fail-over
   */
  async getConnection(): Promise<Connection> {
    // Try current endpoint first
    const currentEndpoint = this.rpcEndpoints[this.currentRpcIndex];

    // Check cache
    let connection = this.rpcConnections.get(currentEndpoint);
    if (!connection) {
      connection = new Connection(currentEndpoint, 'confirmed');
      this.rpcConnections.set(currentEndpoint, connection);
    }

    // Test connection health
    try {
      await connection.getSlot();
      this.recordSuccess('rpc');
      return connection;
    } catch (error) {
      this.recordFailure('rpc', error as Error);
      logger.warn(`RPC endpoint ${currentEndpoint} failed, trying next...`);
    }

    // Try fail-over endpoints
    for (let i = 0; i < this.rpcEndpoints.length; i++) {
      const nextIndex = (this.currentRpcIndex + i + 1) % this.rpcEndpoints.length;
      const endpoint = this.rpcEndpoints[nextIndex];

      try {
        let conn = this.rpcConnections.get(endpoint);
        if (!conn) {
          conn = new Connection(endpoint, 'confirmed');
          this.rpcConnections.set(endpoint, conn);
        }

        await conn.getSlot();
        this.currentRpcIndex = nextIndex;
        this.recordSuccess('rpc');
        logger.info(`Switched to RPC endpoint: ${endpoint}`);
        return conn;
      } catch {
        logger.warn(`RPC endpoint ${endpoint} also failed`);
      }
    }

    // All endpoints failed
    logger.error('All RPC endpoints failed!');
    this.activateKillSwitch('All RPC endpoints unreachable');
    throw new Error('No RPC endpoints available');
  }

  /**
   * Get current RPC endpoint
   */
  getCurrentRpcEndpoint(): string {
    return this.rpcEndpoints[this.currentRpcIndex];
  }

  /**
   * Add a custom RPC endpoint
   */
  addRpcEndpoint(endpoint: string): void {
    if (!this.rpcEndpoints.includes(endpoint)) {
      this.rpcEndpoints.push(endpoint);
      logger.info(`Added RPC endpoint: ${endpoint}`);
    }
  }

  // ============================================================
  // RETRY WITH BACKOFF
  // ============================================================

  /**
   * Execute function with exponential backoff retry
   */
  async withRetry<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      circuitKey?: string;
      onRetry?: (attempt: number, error: Error) => void;
    } = {}
  ): Promise<T> {
    const {
      maxRetries = 4,
      baseDelayMs = 1000,
      maxDelayMs = 16000,
      circuitKey,
      onRetry,
    } = options;

    // Check circuit breaker
    if (circuitKey && this.isCircuitOpen(circuitKey)) {
      throw new Error(`Circuit breaker open for ${circuitKey}`);
    }

    // Check kill switch
    if (this.killSwitch) {
      throw new Error(`Kill switch active: ${this.killSwitchReason}`);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        if (circuitKey) this.recordSuccess(circuitKey);
        return result;
      } catch (error) {
        lastError = error as Error;

        if (circuitKey) this.recordFailure(circuitKey, lastError);

        if (attempt < maxRetries) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
          logger.debug(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`);

          if (onRetry) onRetry(attempt + 1, lastError);

          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Unknown error after retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  // HEALTH CHECK
  // ============================================================

  /**
   * Get overall system health
   */
  getSystemHealth(): {
    killSwitch: { active: boolean; reason: string };
    circuits: { [key: string]: CircuitState };
    rpc: { endpoint: string; index: number; total: number };
  } {
    const circuits: { [key: string]: CircuitState } = {};
    for (const [key, state] of this.circuitBreakers) {
      circuits[key] = state.state;
    }

    return {
      killSwitch: {
        active: this.killSwitch,
        reason: this.killSwitchReason,
      },
      circuits,
      rpc: {
        endpoint: this.getCurrentRpcEndpoint(),
        index: this.currentRpcIndex,
        total: this.rpcEndpoints.length,
      },
    };
  }

  /**
   * Check if system is healthy for trading
   */
  isHealthyForTrading(): boolean {
    if (this.killSwitch) return false;
    if (this.isCircuitOpen('rpc')) return false;
    if (this.isCircuitOpen('jupiter')) return false;
    if (this.isCircuitOpen('trading')) return false;
    return true;
  }
}

// Export singleton
export const failSafe = new FailSafe();
export default failSafe;
