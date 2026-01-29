/**
 * Rate Limiter Utility
 *
 * Provides rate limiting for API calls and user actions
 * to prevent abuse and API quota exhaustion.
 */

import logger from './logger';

interface RateLimitConfig {
  maxRequests: number;       // Max requests per window
  windowMs: number;          // Time window in milliseconds
  blockDurationMs?: number;  // How long to block after exceeding limit
}

interface RateLimitEntry {
  requests: number;
  windowStart: number;
  blocked: boolean;
  blockedUntil: number;
}

// Default rate limits for different services
export const DEFAULT_RATE_LIMITS: { [key: string]: RateLimitConfig } = {
  telegram_user: { maxRequests: 30, windowMs: 60000, blockDurationMs: 60000 }, // 30 req/min per user
  telegram_global: { maxRequests: 300, windowMs: 60000, blockDurationMs: 30000 }, // 300 req/min global
  api_dexscreener: { maxRequests: 100, windowMs: 60000, blockDurationMs: 60000 }, // 100 req/min
  api_jupiter: { maxRequests: 60, windowMs: 60000, blockDurationMs: 30000 }, // 60 req/min
  api_helius: { maxRequests: 50, windowMs: 60000, blockDurationMs: 60000 }, // 50 req/min
  api_birdeye: { maxRequests: 30, windowMs: 60000, blockDurationMs: 60000 }, // 30 req/min
  rpc_solana: { maxRequests: 40, windowMs: 10000, blockDurationMs: 5000 }, // 40 req/10s
  trade_user: { maxRequests: 10, windowMs: 60000, blockDurationMs: 120000 }, // 10 trades/min per user
};

class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize default configs
    for (const [key, config] of Object.entries(DEFAULT_RATE_LIMITS)) {
      this.configs.set(key, config);
    }

    // Cleanup old entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
  }

  /**
   * Check if an action is rate limited
   * @returns true if allowed, false if rate limited
   */
  checkLimit(key: string, identifier?: string): boolean {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const config = this.configs.get(key) || DEFAULT_RATE_LIMITS.telegram_user;
    const now = Date.now();

    let entry = this.limits.get(fullKey);

    // Create new entry if doesn't exist
    if (!entry) {
      entry = {
        requests: 0,
        windowStart: now,
        blocked: false,
        blockedUntil: 0,
      };
      this.limits.set(fullKey, entry);
    }

    // Check if currently blocked
    if (entry.blocked && now < entry.blockedUntil) {
      const remainingMs = entry.blockedUntil - now;
      logger.debug(`Rate limit block active for ${fullKey}: ${remainingMs}ms remaining`);
      return false;
    }

    // Unblock if block period expired
    if (entry.blocked && now >= entry.blockedUntil) {
      entry.blocked = false;
      entry.requests = 0;
      entry.windowStart = now;
    }

    // Reset window if expired
    if (now - entry.windowStart > config.windowMs) {
      entry.requests = 0;
      entry.windowStart = now;
    }

    // Check if limit exceeded
    if (entry.requests >= config.maxRequests) {
      entry.blocked = true;
      entry.blockedUntil = now + (config.blockDurationMs || config.windowMs);
      logger.warn(`Rate limit exceeded for ${fullKey}: blocked for ${config.blockDurationMs || config.windowMs}ms`);
      return false;
    }

    // Increment counter and allow
    entry.requests++;
    return true;
  }

  /**
   * Record a request (same as checkLimit but always allows and tracks)
   */
  recordRequest(key: string, identifier?: string): void {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const config = this.configs.get(key) || DEFAULT_RATE_LIMITS.telegram_user;
    const now = Date.now();

    let entry = this.limits.get(fullKey);

    if (!entry) {
      entry = {
        requests: 0,
        windowStart: now,
        blocked: false,
        blockedUntil: 0,
      };
      this.limits.set(fullKey, entry);
    }

    // Reset window if expired
    if (now - entry.windowStart > config.windowMs) {
      entry.requests = 0;
      entry.windowStart = now;
    }

    entry.requests++;
  }

  /**
   * Get remaining requests in current window
   */
  getRemainingRequests(key: string, identifier?: string): number {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const config = this.configs.get(key) || DEFAULT_RATE_LIMITS.telegram_user;
    const now = Date.now();

    const entry = this.limits.get(fullKey);

    if (!entry) {
      return config.maxRequests;
    }

    // Reset if window expired
    if (now - entry.windowStart > config.windowMs) {
      return config.maxRequests;
    }

    return Math.max(0, config.maxRequests - entry.requests);
  }

  /**
   * Get time until rate limit resets
   */
  getResetTime(key: string, identifier?: string): number {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const config = this.configs.get(key) || DEFAULT_RATE_LIMITS.telegram_user;
    const now = Date.now();

    const entry = this.limits.get(fullKey);

    if (!entry) {
      return 0;
    }

    if (entry.blocked && now < entry.blockedUntil) {
      return entry.blockedUntil - now;
    }

    const windowEnd = entry.windowStart + config.windowMs;
    return Math.max(0, windowEnd - now);
  }

  /**
   * Check if a key is currently blocked
   */
  isBlocked(key: string, identifier?: string): boolean {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const entry = this.limits.get(fullKey);

    if (!entry) return false;

    return entry.blocked && Date.now() < entry.blockedUntil;
  }

  /**
   * Manually unblock a key
   */
  unblock(key: string, identifier?: string): void {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const entry = this.limits.get(fullKey);

    if (entry) {
      entry.blocked = false;
      entry.blockedUntil = 0;
      entry.requests = 0;
      entry.windowStart = Date.now();
    }
  }

  /**
   * Set custom rate limit config
   */
  setConfig(key: string, config: RateLimitConfig): void {
    this.configs.set(key, config);
  }

  /**
   * Get current stats for a key
   */
  getStats(key: string, identifier?: string): { requests: number; remaining: number; blocked: boolean; resetMs: number } {
    const fullKey = identifier ? `${key}:${identifier}` : key;
    const config = this.configs.get(key) || DEFAULT_RATE_LIMITS.telegram_user;
    const entry = this.limits.get(fullKey);

    if (!entry) {
      return {
        requests: 0,
        remaining: config.maxRequests,
        blocked: false,
        resetMs: 0,
      };
    }

    return {
      requests: entry.requests,
      remaining: this.getRemainingRequests(key, identifier),
      blocked: this.isBlocked(key, identifier),
      resetMs: this.getResetTime(key, identifier),
    };
  }

  /**
   * Clean up old entries
   */
  private cleanup(): void {
    const now = Date.now();
    const staleThreshold = 3600000; // 1 hour

    for (const [key, entry] of this.limits) {
      const config = this.getConfigForKey(key);
      const lastActivity = Math.max(entry.windowStart, entry.blockedUntil);

      if (now - lastActivity > staleThreshold) {
        this.limits.delete(key);
      }
    }
  }

  private getConfigForKey(fullKey: string): RateLimitConfig {
    const baseKey = fullKey.split(':')[0];
    return this.configs.get(baseKey) || DEFAULT_RATE_LIMITS.telegram_user;
  }

  /**
   * Stop the cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiter();
export default rateLimiter;
