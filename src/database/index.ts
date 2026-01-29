import Database from 'better-sqlite3';
import { config } from '../config';
import { UserSettings, TradePosition, LearningData, RunnerPattern } from '../types';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

// Use config values instead of hardcoded credentials
const FREE_ADMIN_USERNAME = config.subscription.freeAdminUsername;
const SUBSCRIPTION_PRICE_SOL = config.subscription.priceSol;
const SUBSCRIPTION_DURATION_DAYS = config.subscription.durationDays;
const MAIN_WALLET = config.subscription.mainWallet;

class DatabaseManager {
  private db: Database.Database;

  constructor() {
    const dbDir = path.dirname(config.database.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(config.database.path);
    this.initialize();
    this.initializePatternTables();
  }

  /**
   * Safely add a column to a table - ignores "column already exists" errors,
   * but logs other database errors
   */
  private safeAddColumn(table: string, column: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.debug(`Added column ${column} to ${table}`);
    } catch (error: any) {
      // SQLite error when column exists is "duplicate column name"
      if (error.message?.includes('duplicate column')) {
        // Expected - column already exists
        return;
      }
      // Log unexpected errors
      logger.error(`Error adding column ${column} to ${table}:`, error);
    }
  }

  private initialize() {
    // Users table with extended fields
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        telegram_username TEXT,
        preset TEXT DEFAULT 'balanced',
        paper_trading INTEGER DEFAULT 1,
        auto_trade INTEGER DEFAULT 0,
        alert_threshold REAL DEFAULT 0.3,
        notifications_enabled INTEGER DEFAULT 1,
        paper_balance REAL DEFAULT 100.0,
        default_trade_size REAL DEFAULT 0.35,
        high_confidence_trade_size REAL DEFAULT 0.5,
        take_profit_percentage REAL DEFAULT 30.0,
        stop_loss_percentage REAL DEFAULT 15.0,
        is_subscribed INTEGER DEFAULT 0,
        subscription_expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add columns if they don't exist (for existing databases)
    this.safeAddColumn('users', 'telegram_username', 'TEXT');
    this.safeAddColumn('users', 'paper_balance', 'REAL DEFAULT 100.0');
    this.safeAddColumn('users', 'default_trade_size', 'REAL DEFAULT 0.35');
    this.safeAddColumn('users', 'high_confidence_trade_size', 'REAL DEFAULT 0.5');
    this.safeAddColumn('users', 'take_profit_percentage', 'REAL DEFAULT 30.0');
    this.safeAddColumn('users', 'stop_loss_percentage', 'REAL DEFAULT 15.0');
    this.safeAddColumn('users', 'is_subscribed', 'INTEGER DEFAULT 0');
    this.safeAddColumn('users', 'subscription_expires_at', 'DATETIME');

    // Subscription payments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        payment_wallet TEXT,
        payment_wallet_encrypted_key TEXT,
        amount_sol REAL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Positions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        contract_address TEXT,
        symbol TEXT,
        entry_price REAL,
        current_price REAL,
        amount REAL,
        sol_invested REAL,
        pnl REAL,
        pnl_percentage REAL,
        opened_at DATETIME,
        closed_at DATETIME,
        status TEXT,
        type TEXT,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Learning data table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id TEXT,
        trade_id TEXT,
        outcome TEXT,
        return_percentage REAL,
        entry_signals TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Patterns table (for custom user patterns)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_patterns (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        description TEXT,
        signals TEXT,
        confidence REAL DEFAULT 0.5,
        success_rate REAL DEFAULT 0.0,
        avg_return REAL DEFAULT 0.0,
        sample_size INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Tracked wallets table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_wallets (
        address TEXT PRIMARY KEY,
        label TEXT,
        is_smart_money INTEGER DEFAULT 0,
        is_whale INTEGER DEFAULT 0,
        profit_rate REAL DEFAULT 0.0,
        recent_wins INTEGER DEFAULT 0,
        wallet_age INTEGER DEFAULT 0,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // User wallets table (for trading)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        user_id INTEGER PRIMARY KEY,
        public_key TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        pin_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_balance_check DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Favorites table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        contract_address TEXT,
        symbol TEXT,
        name TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, contract_address),
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Take Profit / Stop Loss orders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tp_sl_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        position_id TEXT,
        contract_address TEXT,
        order_type TEXT,
        trigger_price REAL,
        trigger_percentage REAL,
        amount_percentage REAL DEFAULT 100,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        triggered_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // DCA (Dollar Cost Averaging) orders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dca_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        contract_address TEXT,
        symbol TEXT,
        sol_amount REAL,
        frequency_minutes INTEGER,
        total_executions INTEGER,
        executed_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        next_execution DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Successful patterns table (2x+ winners for learning)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS successful_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        contract_address TEXT,
        entry_price REAL,
        pnl_percentage REAL,
        overall_score INTEGER,
        confidence REAL,
        recommendation TEXT,
        patterns TEXT,
        technical_score TEXT,
        fundamental_score TEXT,
        timestamp TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Token lore/stories table for narrative analysis
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_lore (
        contract_address TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        lore TEXT,
        narrative_strength INTEGER DEFAULT 0,
        is_buy INTEGER DEFAULT 0,
        buy_reason TEXT,
        not_buy_reason TEXT,
        analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Paper trade history with detailed tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        position_id TEXT,
        contract_address TEXT,
        symbol TEXT,
        action TEXT,
        amount_sol REAL,
        token_amount REAL,
        price REAL,
        paper_balance_before REAL,
        paper_balance_after REAL,
        pnl REAL,
        pnl_percentage REAL,
        confidence REAL,
        narrative_strength INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Scanned tokens tracking for mandatory buy signals
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scanned_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_address TEXT,
        symbol TEXT,
        name TEXT,
        score REAL,
        confidence REAL,
        recommendation TEXT,
        scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        buy_signal_sent INTEGER DEFAULT 0
      )
    `);

    // Alpha picks table - tokens with score >= 29 and successful 100x tokens
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alpha_picks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_address TEXT UNIQUE,
        symbol TEXT,
        name TEXT,
        initial_score REAL,
        initial_price REAL,
        current_price REAL,
        peak_price REAL,
        peak_multiplier REAL DEFAULT 1.0,
        is_100x INTEGER DEFAULT 0,
        pump_reason TEXT,
        alpha_reason TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // User-specific scanning sessions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_scan_sessions (
        user_id INTEGER PRIMARY KEY,
        is_scanning INTEGER DEFAULT 0,
        scan_started_at DATETIME,
        tokens_scanned INTEGER DEFAULT 0,
        last_scan_time DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
      )
    `);

    // Add columns to users table for per-user paper trading
    this.safeAddColumn('users', 'total_paper_trades', 'INTEGER DEFAULT 0');
    this.safeAddColumn('users', 'paper_pnl_total', 'REAL DEFAULT 0');
    this.safeAddColumn('users', 'paper_winners', 'INTEGER DEFAULT 0');
    this.safeAddColumn('users', 'paper_losers', 'INTEGER DEFAULT 0');

    logger.info('Database initialized successfully');
  }

  // Get main wallet for payments
  getMainWallet(): string {
    return MAIN_WALLET;
  }

  // Get subscription price
  getSubscriptionPrice(): number {
    return SUBSCRIPTION_PRICE_SOL;
  }

  // Get free admin username
  getFreeAdminUsername(): string {
    return FREE_ADMIN_USERNAME;
  }

  getUserSettings(userId: number): UserSettings | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE user_id = ?');
    const row = stmt.get(userId) as any;

    if (!row) return null;

    return {
      userId: row.user_id,
      telegramUsername: row.telegram_username,
      preset: row.preset,
      paperTrading: row.paper_trading === 1,
      autoTrade: row.auto_trade === 1,
      alertThreshold: row.alert_threshold || 0.3,
      notificationsEnabled: row.notifications_enabled === 1,
      paperBalance: row.paper_balance || 100.0,
      defaultTradeSize: row.default_trade_size || 0.35,
      highConfidenceTradeSize: row.high_confidence_trade_size || 0.5,
      takeProfitPercentage: row.take_profit_percentage || 30.0,
      stopLossPercentage: row.stop_loss_percentage || 15.0,
      isSubscribed: row.is_subscribed === 1,
      subscriptionExpiresAt: row.subscription_expires_at ? new Date(row.subscription_expires_at) : undefined,
      customPatterns: [],
    };
  }

  // Check if user has access (is admin or has valid subscription)
  // STRICT: Returns false by default, only true if explicitly subscribed
  hasAccess(userId: number, telegramUsername?: string): boolean {
    // Check if it's the free admin - exact match only
    if (telegramUsername && telegramUsername.toLowerCase() === FREE_ADMIN_USERNAME.toLowerCase()) {
      logger.info(`Admin access for ${telegramUsername}`);
      return true;
    }

    const settings = this.getUserSettings(userId);

    // No settings = no access
    if (!settings) {
      logger.info(`No settings found for user ${userId} - access denied`);
      return false;
    }

    // Check username in settings matches admin
    if (settings.telegramUsername && settings.telegramUsername.toLowerCase() === FREE_ADMIN_USERNAME.toLowerCase()) {
      logger.info(`Admin access via stored username for user ${userId}`);
      return true;
    }

    // Check subscription - MUST have both is_subscribed = true AND valid expiry date
    if (settings.isSubscribed === true && settings.subscriptionExpiresAt) {
      const now = new Date();
      const expiryDate = new Date(settings.subscriptionExpiresAt);

      if (now < expiryDate) {
        logger.info(`Subscription valid for user ${userId} until ${expiryDate.toISOString()}`);
        return true;
      } else {
        logger.info(`Subscription EXPIRED for user ${userId} at ${expiryDate.toISOString()}`);
        return false;
      }
    }

    // Default: NO ACCESS
    logger.info(`No valid subscription for user ${userId} - access denied`);
    return false;
  }

  // Update user's telegram username
  updateTelegramUsername(userId: number, username: string): void {
    const stmt = this.db.prepare('UPDATE users SET telegram_username = ? WHERE user_id = ?');
    stmt.run(username, userId);
  }

  // Update paper balance
  updatePaperBalance(userId: number, newBalance: number): void {
    const stmt = this.db.prepare('UPDATE users SET paper_balance = ? WHERE user_id = ?');
    stmt.run(newBalance, userId);
  }

  // Get paper balance
  getPaperBalance(userId: number): number {
    const stmt = this.db.prepare('SELECT paper_balance FROM users WHERE user_id = ?');
    const row = stmt.get(userId) as any;
    return row?.paper_balance || 100.0;
  }

  // Update editable settings
  updateEditableSettings(userId: number, settings: {
    alertThreshold?: number;
    takeProfitPercentage?: number;
    stopLossPercentage?: number;
    defaultTradeSize?: number;
    highConfidenceTradeSize?: number;
  }): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (settings.alertThreshold !== undefined) {
      updates.push('alert_threshold = ?');
      values.push(settings.alertThreshold);
    }
    if (settings.takeProfitPercentage !== undefined) {
      updates.push('take_profit_percentage = ?');
      values.push(settings.takeProfitPercentage);
    }
    if (settings.stopLossPercentage !== undefined) {
      updates.push('stop_loss_percentage = ?');
      values.push(settings.stopLossPercentage);
    }
    if (settings.defaultTradeSize !== undefined) {
      updates.push('default_trade_size = ?');
      values.push(settings.defaultTradeSize);
    }
    if (settings.highConfidenceTradeSize !== undefined) {
      updates.push('high_confidence_trade_size = ?');
      values.push(settings.highConfidenceTradeSize);
    }

    if (updates.length > 0) {
      values.push(userId);
      const stmt = this.db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`);
      stmt.run(...values);
    }
  }

  // Create subscription payment record
  createSubscriptionPayment(userId: number, paymentWallet: string, encryptedKey: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO subscription_payments (user_id, payment_wallet, payment_wallet_encrypted_key, amount_sol, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(userId, paymentWallet, encryptedKey, SUBSCRIPTION_PRICE_SOL);
    return result.lastInsertRowid as number;
  }

  // Get pending payment for user
  getPendingPayment(userId: number): any | null {
    const stmt = this.db.prepare(`
      SELECT * FROM subscription_payments
      WHERE user_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(userId) as any;
  }

  // Confirm subscription payment
  confirmSubscriptionPayment(paymentId: number, userId: number): void {
    // Update payment status
    const updatePayment = this.db.prepare(`
      UPDATE subscription_payments
      SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    updatePayment.run(paymentId);

    // Update user subscription
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SUBSCRIPTION_DURATION_DAYS);

    const updateUser = this.db.prepare(`
      UPDATE users
      SET is_subscribed = 1, subscription_expires_at = ?
      WHERE user_id = ?
    `);
    updateUser.run(expiresAt.toISOString(), userId);
  }

  // Save token lore
  saveTokenLore(data: {
    contractAddress: string;
    symbol: string;
    name: string;
    lore: string;
    narrativeStrength: number;
    isBuy: boolean;
    buyReason?: string;
    notBuyReason?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO token_lore
      (contract_address, symbol, name, lore, narrative_strength, is_buy, buy_reason, not_buy_reason, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(
      data.contractAddress,
      data.symbol,
      data.name,
      data.lore,
      data.narrativeStrength,
      data.isBuy ? 1 : 0,
      data.buyReason || null,
      data.notBuyReason || null
    );
  }

  // Get token lore
  getTokenLore(contractAddress: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM token_lore WHERE contract_address = ?');
    return stmt.get(contractAddress) as any;
  }

  // Record paper trade in history
  recordPaperTradeHistory(data: {
    userId: number;
    positionId: string;
    contractAddress: string;
    symbol: string;
    action: 'buy' | 'sell';
    amountSol: number;
    tokenAmount: number;
    price: number;
    paperBalanceBefore: number;
    paperBalanceAfter: number;
    pnl?: number;
    pnlPercentage?: number;
    confidence?: number;
    narrativeStrength?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO paper_trade_history
      (user_id, position_id, contract_address, symbol, action, amount_sol, token_amount, price,
       paper_balance_before, paper_balance_after, pnl, pnl_percentage, confidence, narrative_strength)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      data.userId,
      data.positionId,
      data.contractAddress,
      data.symbol,
      data.action,
      data.amountSol,
      data.tokenAmount,
      data.price,
      data.paperBalanceBefore,
      data.paperBalanceAfter,
      data.pnl || 0,
      data.pnlPercentage || 0,
      data.confidence || 0,
      data.narrativeStrength || 0
    );
  }

  // Get paper trade history for user
  getPaperTradeHistory(userId: number, limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM paper_trade_history
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit) as any[];
  }

  // Save scanned token for mandatory buy signal logic
  saveScannedToken(data: {
    contractAddress: string;
    symbol: string;
    name: string;
    score: number;
    confidence: number;
    recommendation: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO scanned_tokens (contract_address, symbol, name, score, confidence, recommendation)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      data.contractAddress,
      data.symbol,
      data.name,
      data.score,
      data.confidence,
      data.recommendation
    );
  }

  // Get best scanned token in last N minutes that hasn't had buy signal
  getBestScannedTokenSince(minutes: number): any | null {
    const stmt = this.db.prepare(`
      SELECT * FROM scanned_tokens
      WHERE scanned_at >= datetime('now', '-' || ? || ' minutes')
      AND buy_signal_sent = 0
      ORDER BY score DESC, confidence DESC
      LIMIT 1
    `);
    return stmt.get(minutes) as any;
  }

  // Mark token as having buy signal sent
  markBuySignalSent(contractAddress: string): void {
    const stmt = this.db.prepare(`
      UPDATE scanned_tokens SET buy_signal_sent = 1 WHERE contract_address = ?
    `);
    stmt.run(contractAddress);
  }

  // Get last buy signal time
  getLastBuySignalTime(): Date | null {
    const stmt = this.db.prepare(`
      SELECT MAX(scanned_at) as last_signal FROM scanned_tokens WHERE buy_signal_sent = 1
    `);
    const row = stmt.get() as any;
    return row?.last_signal ? new Date(row.last_signal) : null;
  }

  // Clean old scanned tokens (older than 24 hours)
  cleanOldScannedTokens(): void {
    const stmt = this.db.prepare(`
      DELETE FROM scanned_tokens WHERE scanned_at < datetime('now', '-24 hours')
    `);
    stmt.run();
  }

  createUser(userId: number): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO users (user_id) VALUES (?)'
    );
    stmt.run(userId);
  }

  updateUserSettings(userId: number, settings: Partial<UserSettings>): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (settings.preset !== undefined) {
      updates.push('preset = ?');
      values.push(settings.preset);
    }
    if (settings.paperTrading !== undefined) {
      updates.push('paper_trading = ?');
      values.push(settings.paperTrading ? 1 : 0);
    }
    if (settings.autoTrade !== undefined) {
      updates.push('auto_trade = ?');
      values.push(settings.autoTrade ? 1 : 0);
    }
    if (settings.alertThreshold !== undefined) {
      updates.push('alert_threshold = ?');
      values.push(settings.alertThreshold);
    }

    if (updates.length > 0) {
      values.push(userId);
      const stmt = this.db.prepare(
        `UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`
      );
      stmt.run(...values);
    }
  }

  savePosition(position: TradePosition): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO positions
      (id, user_id, contract_address, symbol, entry_price, current_price,
       amount, sol_invested, pnl, pnl_percentage, opened_at, closed_at, status, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      position.id,
      position.userId || 0,
      position.contractAddress,
      position.symbol,
      position.entryPrice,
      position.currentPrice,
      position.amount,
      position.solInvested,
      position.pnl,
      position.pnlPercentage,
      position.openedAt.toISOString(),
      position.closedAt?.toISOString() || null,
      position.status,
      position.type
    );
  }

  getOpenPositions(userId: number = 0): TradePosition[] {
    const stmt = this.db.prepare(
      'SELECT * FROM positions WHERE user_id = ? AND status = ? ORDER BY opened_at DESC'
    );
    const rows = stmt.all(userId, 'open') as any[];

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      contractAddress: row.contract_address,
      symbol: row.symbol,
      entryPrice: row.entry_price,
      currentPrice: row.current_price,
      amount: row.amount,
      solInvested: row.sol_invested,
      pnl: row.pnl,
      pnlPercentage: row.pnl_percentage,
      openedAt: new Date(row.opened_at),
      closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
      status: row.status,
      type: row.type,
    }));
  }

  /**
   * Get ALL open positions across all users (for position monitoring)
   */
  getAllOpenPositions(): TradePosition[] {
    const stmt = this.db.prepare(`
      SELECT * FROM positions WHERE status = 'open'
    `);
    const rows = stmt.all() as any[];

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      contractAddress: row.contract_address,
      symbol: row.symbol,
      entryPrice: row.entry_price,
      currentPrice: row.current_price,
      amount: row.amount,
      solInvested: row.sol_invested,
      pnl: row.pnl,
      pnlPercentage: row.pnl_percentage,
      openedAt: new Date(row.opened_at),
      closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
      status: row.status,
      type: row.type,
    }));
  }

  saveLearningData(data: LearningData): void {
    const stmt = this.db.prepare(`
      INSERT INTO learning_data (pattern_id, trade_id, outcome, return_percentage, entry_signals)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.patternId,
      data.tradeId,
      data.outcome,
      data.returnPercentage,
      JSON.stringify(data.entrySignals)
    );
  }

  getPatternPerformance(patternId: string): { successRate: number; avgReturn: number; sampleSize: number } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) as wins,
        AVG(return_percentage) as avg_return
      FROM learning_data
      WHERE pattern_id = ?
    `);

    const result = stmt.get(patternId) as any;

    return {
      successRate: result.total > 0 ? result.wins / result.total : 0,
      avgReturn: result.avg_return || 0,
      sampleSize: result.total || 0,
    };
  }

  getRecentTradesForPattern(patternId: string, limit: number): any[] {
    const stmt = this.db.prepare(`
      SELECT pattern_id, trade_id, outcome, return_percentage, entry_signals, timestamp
      FROM learning_data
      WHERE pattern_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(patternId, limit) as any[];

    return rows.map(row => ({
      patternId: row.pattern_id,
      tradeId: row.trade_id,
      outcome: row.outcome,
      returnPercentage: row.return_percentage,
      entrySignals: row.entry_signals ? JSON.parse(row.entry_signals) : {},
      timestamp: new Date(row.timestamp),
    }));
  }

  createWallet(userId: number, publicKey: string, encryptedPrivateKey: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_wallets (user_id, public_key, encrypted_private_key)
      VALUES (?, ?, ?)
    `);
    stmt.run(userId, publicKey, encryptedPrivateKey);
  }

  getUserWallet(userId: number): { publicKey: string; encryptedPrivateKey: string } | null {
    const stmt = this.db.prepare('SELECT * FROM user_wallets WHERE user_id = ?');
    const row = stmt.get(userId) as any;

    if (!row) return null;

    return {
      publicKey: row.public_key,
      encryptedPrivateKey: row.encrypted_private_key,
    };
  }

  updateWalletBalanceCheck(userId: number): void {
    const stmt = this.db.prepare(`
      UPDATE user_wallets
      SET last_balance_check = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `);
    stmt.run(userId);
  }

  setPinHash(userId: number, pinHash: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_wallets
      SET pin_hash = ?
      WHERE user_id = ?
    `);
    stmt.run(pinHash, userId);
  }

  getPinHash(userId: number): string | null {
    const stmt = this.db.prepare('SELECT pin_hash FROM user_wallets WHERE user_id = ?');
    const row = stmt.get(userId) as any;
    return row?.pin_hash || null;
  }

  // Favorites methods
  addFavorite(userId: number, contractAddress: string, symbol: string, name: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO favorites (user_id, contract_address, symbol, name)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(userId, contractAddress, symbol, name);
  }

  removeFavorite(userId: number, contractAddress: string): void {
    const stmt = this.db.prepare('DELETE FROM favorites WHERE user_id = ? AND contract_address = ?');
    stmt.run(userId, contractAddress);
  }

  isFavorite(userId: number, contractAddress: string): boolean {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ? AND contract_address = ?');
    const row = stmt.get(userId, contractAddress) as any;
    return row.count > 0;
  }

  getFavorites(userId: number): Array<{ contractAddress: string; symbol: string; name: string; addedAt: string }> {
    const stmt = this.db.prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY added_at DESC');
    const rows = stmt.all(userId) as any[];
    return rows.map(row => ({
      contractAddress: row.contract_address,
      symbol: row.symbol,
      name: row.name,
      addedAt: row.added_at,
    }));
  }

  // TP/SL methods
  createTPSLOrder(
    userId: number,
    positionId: string,
    contractAddress: string,
    orderType: 'tp' | 'sl',
    triggerPrice: number,
    triggerPercentage: number,
    amountPercentage: number = 100
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO tp_sl_orders (user_id, position_id, contract_address, order_type, trigger_price, trigger_percentage, amount_percentage)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(userId, positionId, contractAddress, orderType, triggerPrice, triggerPercentage, amountPercentage);
    return result.lastInsertRowid as number;
  }

  getActiveTPSLOrders(userId: number, contractAddress?: string): Array<any> {
    let query = 'SELECT * FROM tp_sl_orders WHERE user_id = ? AND status = ?';
    const params: any[] = [userId, 'active'];

    if (contractAddress) {
      query += ' AND contract_address = ?';
      params.push(contractAddress);
    }

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as any[];
  }

  cancelTPSLOrder(orderId: number): void {
    const stmt = this.db.prepare('UPDATE tp_sl_orders SET status = ? WHERE id = ?');
    stmt.run('cancelled', orderId);
  }

  // DCA methods
  createDCAOrder(
    userId: number,
    contractAddress: string,
    symbol: string,
    solAmount: number,
    frequencyMinutes: number,
    totalExecutions: number
  ): number {
    const nextExecution = new Date(Date.now() + frequencyMinutes * 60 * 1000);
    const stmt = this.db.prepare(`
      INSERT INTO dca_orders (user_id, contract_address, symbol, sol_amount, frequency_minutes, total_executions, next_execution)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(userId, contractAddress, symbol, solAmount, frequencyMinutes, totalExecutions, nextExecution.toISOString());
    return result.lastInsertRowid as number;
  }

  getActiveDCAOrders(userId: number): Array<any> {
    const stmt = this.db.prepare('SELECT * FROM dca_orders WHERE user_id = ? AND status = ? ORDER BY next_execution');
    return stmt.all(userId, 'active') as any[];
  }

  updateDCAOrder(orderId: number, executedCount: number, nextExecution: Date): void {
    const stmt = this.db.prepare(`
      UPDATE dca_orders
      SET executed_count = ?, next_execution = ?
      WHERE id = ?
    `);
    stmt.run(executedCount, nextExecution.toISOString(), orderId);
  }

  cancelDCAOrder(orderId: number): void {
    const stmt = this.db.prepare('UPDATE dca_orders SET status = ? WHERE id = ?');
    stmt.run('cancelled', orderId);
  }

  completeDCAOrder(orderId: number): void {
    const stmt = this.db.prepare('UPDATE dca_orders SET status = ? WHERE id = ?');
    stmt.run('completed', orderId);
  }

  saveSuccessfulPattern(data: any): void {
    const stmt = this.db.prepare(`
      INSERT INTO successful_patterns (
        symbol, contract_address, entry_price, pnl_percentage, overall_score,
        confidence, recommendation, patterns, technical_score, fundamental_score, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.symbol,
      data.contractAddress,
      data.entryPrice,
      data.pnlPercentage,
      data.overallScore,
      data.confidence,
      data.recommendation,
      data.patterns,
      JSON.stringify(data.technicalScore),
      JSON.stringify(data.fundamentalScore),
      data.timestamp
    );
  }

  getSuccessfulPatterns(minPnlPercentage: number = 100): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM successful_patterns
      WHERE pnl_percentage >= ?
      ORDER BY created_at DESC
    `);

    return stmt.all(minPnlPercentage) as any[];
  }

  getAllPaperTrades(userId: number = 0): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM positions
      WHERE user_id = ? AND type = 'paper'
      ORDER BY opened_at DESC
    `);

    return stmt.all(userId) as any[];
  }

  getPaperTradeStats(userId: number = 0): any {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_trades,
        SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END) as winners,
        SUM(CASE WHEN status = 'closed' AND pnl <= 0 THEN 1 ELSE 0 END) as losers,
        AVG(pnl_percentage) as avg_pnl_percentage,
        SUM(pnl) as total_pnl
      FROM positions
      WHERE user_id = ? AND type = 'paper'
    `);

    return stmt.get(userId);
  }

  getClosedPositions(userId: number = 0): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM positions
      WHERE user_id = ? AND status = 'closed'
      ORDER BY closed_at DESC
    `);

    return stmt.all(userId) as any[];
  }

  // Alpha picks methods
  saveAlphaPick(data: {
    contractAddress: string;
    symbol: string;
    name: string;
    initialScore: number;
    initialPrice: number;
    alphaReason: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO alpha_picks
      (contract_address, symbol, name, initial_score, initial_price, current_price, alpha_reason, added_at, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    stmt.run(
      data.contractAddress,
      data.symbol,
      data.name,
      data.initialScore,
      data.initialPrice,
      data.initialPrice,
      data.alphaReason
    );
  }

  updateAlphaPickPrice(contractAddress: string, currentPrice: number): void {
    const stmt = this.db.prepare(`
      UPDATE alpha_picks
      SET current_price = ?,
          peak_price = CASE WHEN ? > COALESCE(peak_price, 0) THEN ? ELSE peak_price END,
          peak_multiplier = CASE WHEN initial_price > 0 AND ? > COALESCE(peak_price, 0)
            THEN ? / initial_price ELSE peak_multiplier END,
          last_updated = CURRENT_TIMESTAMP
      WHERE contract_address = ?
    `);
    stmt.run(currentPrice, currentPrice, currentPrice, currentPrice, currentPrice, contractAddress);
  }

  mark100xToken(contractAddress: string, pumpReason: string): void {
    const stmt = this.db.prepare(`
      UPDATE alpha_picks
      SET is_100x = 1, pump_reason = ?, last_updated = CURRENT_TIMESTAMP
      WHERE contract_address = ?
    `);
    stmt.run(pumpReason, contractAddress);
  }

  getAlphaPicks(limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM alpha_picks
      ORDER BY added_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as any[];
  }

  get100xTokens(): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM alpha_picks
      WHERE is_100x = 1
      ORDER BY peak_multiplier DESC
    `);
    return stmt.all() as any[];
  }

  getAlphaPickByAddress(contractAddress: string): any | null {
    const stmt = this.db.prepare(`
      SELECT * FROM alpha_picks WHERE contract_address = ?
    `);
    return stmt.get(contractAddress) as any;
  }

  // User scan session methods
  startUserScanSession(userId: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_scan_sessions
      (user_id, is_scanning, scan_started_at, tokens_scanned, last_scan_time)
      VALUES (?, 1, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP)
    `);
    stmt.run(userId);
  }

  stopUserScanSession(userId: number): void {
    const stmt = this.db.prepare(`
      UPDATE user_scan_sessions
      SET is_scanning = 0
      WHERE user_id = ?
    `);
    stmt.run(userId);
  }

  isUserScanning(userId: number): boolean {
    const stmt = this.db.prepare(`
      SELECT is_scanning FROM user_scan_sessions WHERE user_id = ?
    `);
    const row = stmt.get(userId) as any;
    return row?.is_scanning === 1;
  }

  incrementUserTokensScanned(userId: number): void {
    const stmt = this.db.prepare(`
      UPDATE user_scan_sessions
      SET tokens_scanned = tokens_scanned + 1, last_scan_time = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `);
    stmt.run(userId);
  }

  getUserScanStats(userId: number): any {
    const stmt = this.db.prepare(`
      SELECT * FROM user_scan_sessions WHERE user_id = ?
    `);
    return stmt.get(userId) as any;
  }

  getAllActiveScanners(): number[] {
    const stmt = this.db.prepare(`
      SELECT user_id FROM user_scan_sessions WHERE is_scanning = 1
    `);
    const rows = stmt.all() as any[];
    return rows.map(r => r.user_id);
  }

  /**
   * Get all users with auto-trade enabled
   * Returns array of user settings for users with auto_trade = 1
   */
  getUsersWithAutoTrade(): { userId: number; paperTrading: boolean; preset: string }[] {
    const stmt = this.db.prepare(`
      SELECT user_id, paper_trading, preset FROM users WHERE auto_trade = 1
    `);
    const rows = stmt.all() as any[];
    return rows.map(r => ({
      userId: r.user_id,
      paperTrading: r.paper_trading === 1,
      preset: r.preset,
    }));
  }

  /**
   * Get all users with active subscriptions who have auto-trade enabled
   */
  getAutoTradeSubscribers(): { userId: number; paperTrading: boolean; preset: string }[] {
    const stmt = this.db.prepare(`
      SELECT user_id, paper_trading, preset FROM users
      WHERE auto_trade = 1
      AND is_subscribed = 1
      AND subscription_expires_at > datetime('now')
    `);
    const rows = stmt.all() as any[];
    return rows.map(r => ({
      userId: r.user_id,
      paperTrading: r.paper_trading === 1,
      preset: r.preset,
    }));
  }

  // ============================================================
  // PATTERN STATUS AND BLACKLIST METHODS
  // ============================================================

  /**
   * Initialize pattern status and blacklist tables
   */
  initializePatternTables(): void {
    // Pattern status table for tracking enabled/disabled and weights
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pattern_status (
        pattern_id TEXT PRIMARY KEY,
        pattern_name TEXT NOT NULL,
        is_enabled INTEGER DEFAULT 1,
        is_blacklisted INTEGER DEFAULT 0,
        blacklist_reason TEXT,
        weight REAL DEFAULT 1.0,
        win_rate REAL DEFAULT 0.5,
        avg_return REAL DEFAULT 0,
        sample_size INTEGER DEFAULT 0,
        consecutive_losses INTEGER DEFAULT 0,
        consecutive_wins INTEGER DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Blacklisted patterns table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blacklisted_patterns (
        pattern_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        blacklisted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        redeemed_at DATETIME
      )
    `);

    // Strategy performance log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_performance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id TEXT NOT NULL,
        win_rate REAL,
        avg_return REAL,
        sample_size INTEGER,
        weight REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // System logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Advanced position configs table (tiered TP, trailing stop)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS advanced_position_configs (
        position_id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * Get pattern status from database
   */
  getPatternStatus(patternId: string): any | null {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM pattern_status WHERE pattern_id = ?
      `);
      const row = stmt.get(patternId) as any;
      if (!row) return null;

      return {
        patternId: row.pattern_id,
        patternName: row.pattern_name,
        isEnabled: row.is_enabled === 1,
        isBlacklisted: row.is_blacklisted === 1,
        blacklistReason: row.blacklist_reason,
        weight: row.weight,
        winRate: row.win_rate,
        avgReturn: row.avg_return,
        sampleSize: row.sample_size,
        consecutiveLosses: row.consecutive_losses,
        consecutiveWins: row.consecutive_wins,
        lastUpdated: new Date(row.last_updated),
      };
    } catch {
      return null;
    }
  }

  /**
   * Save pattern status to database
   */
  savePatternStatus(status: any): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pattern_status (
        pattern_id, pattern_name, is_enabled, is_blacklisted, blacklist_reason,
        weight, win_rate, avg_return, sample_size, consecutive_losses,
        consecutive_wins, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      status.patternId,
      status.patternName,
      status.isEnabled ? 1 : 0,
      status.isBlacklisted ? 1 : 0,
      status.blacklistReason || null,
      status.weight,
      status.winRate,
      status.avgReturn,
      status.sampleSize,
      status.consecutiveLosses,
      status.consecutiveWins,
      status.lastUpdated.toISOString()
    );

    // Log strategy performance change
    this.logStrategyPerformance(status.patternId, status.winRate, status.avgReturn, status.sampleSize, status.weight);
  }

  /**
   * Log strategy performance for historical tracking
   */
  logStrategyPerformance(patternId: string, winRate: number, avgReturn: number, sampleSize: number, weight: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO strategy_performance_log (pattern_id, win_rate, avg_return, sample_size, weight)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(patternId, winRate, avgReturn, sampleSize, weight);
  }

  /**
   * Get all pattern statuses
   */
  getAllPatternStatuses(): any[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM pattern_status ORDER BY weight DESC');
      return stmt.all() as any[];
    } catch {
      return [];
    }
  }

  /**
   * Save blacklisted pattern
   */
  saveBlacklistedPattern(patternId: string, reason: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blacklisted_patterns (pattern_id, reason, blacklisted_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(patternId, reason);

    // Log the blacklist event
    this.saveSystemLog('warning', 'pattern_blacklist', `Pattern ${patternId} blacklisted: ${reason}`);
  }

  /**
   * Remove pattern from blacklist
   */
  removeBlacklistedPattern(patternId: string): void {
    const stmt = this.db.prepare(`
      UPDATE blacklisted_patterns
      SET redeemed_at = CURRENT_TIMESTAMP
      WHERE pattern_id = ?
    `);
    stmt.run(patternId);

    // Log the redemption event
    this.saveSystemLog('info', 'pattern_redemption', `Pattern ${patternId} redeemed from blacklist`);
  }

  /**
   * Get all currently blacklisted patterns
   */
  getBlacklistedPatterns(): any[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM blacklisted_patterns
        WHERE redeemed_at IS NULL
        ORDER BY blacklisted_at DESC
      `);
      return stmt.all() as any[];
    } catch {
      return [];
    }
  }

  /**
   * Get strategy performance history
   */
  getStrategyPerformanceHistory(patternId: string, limit: number = 100): any[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM strategy_performance_log
        WHERE pattern_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      return stmt.all(patternId, limit) as any[];
    } catch {
      return [];
    }
  }

  /**
   * Save system log entry
   */
  saveSystemLog(level: string, category: string, message: string, details?: any): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO system_logs (level, category, message, details)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(level, category, message, details ? JSON.stringify(details) : null);
    } catch (error) {
      // Silently fail - don't let logging failures break the app
      console.error('Failed to save system log:', error);
    }
  }

  /**
   * Get system logs
   */
  getSystemLogs(category?: string, limit: number = 100): any[] {
    try {
      let query = 'SELECT * FROM system_logs';
      const params: any[] = [];

      if (category) {
        query += ' WHERE category = ?';
        params.push(category);
      }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);

      const stmt = this.db.prepare(query);
      return stmt.all(...params) as any[];
    } catch {
      return [];
    }
  }

  /**
   * Get strategy rankings by profitability
   */
  getStrategyRankings(): any[] {
    try {
      const stmt = this.db.prepare(`
        SELECT
          ps.pattern_id,
          ps.pattern_name,
          ps.is_enabled,
          ps.is_blacklisted,
          ps.weight,
          ps.win_rate,
          ps.avg_return,
          ps.sample_size,
          (ps.win_rate * ps.avg_return) as risk_adjusted_return,
          (ps.avg_return * ps.sample_size) as total_profit
        FROM pattern_status ps
        WHERE ps.sample_size >= 5
        ORDER BY total_profit DESC
      `);
      return stmt.all() as any[];
    } catch {
      return [];
    }
  }

  // ============================================================
  // ADVANCED POSITION CONFIG METHODS (Tiered TP, Trailing Stop)
  // ============================================================

  /**
   * Save advanced position config
   */
  saveAdvancedPositionConfig(positionId: string, config: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO advanced_position_configs (position_id, config, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(positionId, config);
  }

  /**
   * Get advanced position config
   */
  getAdvancedPositionConfig(positionId: string): any | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM advanced_position_configs WHERE position_id = ?');
      return stmt.get(positionId) as any;
    } catch {
      return null;
    }
  }

  /**
   * Get all advanced position configs
   */
  getAdvancedPositionConfigs(): any[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM advanced_position_configs');
      return stmt.all() as any[];
    } catch {
      return [];
    }
  }

  /**
   * Delete advanced position config
   */
  deleteAdvancedPositionConfig(positionId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM advanced_position_configs WHERE position_id = ?');
      stmt.run(positionId);
    } catch {
      // Ignore errors
    }
  }

  close(): void {
    this.db.close();
  }
}

export default new DatabaseManager();
