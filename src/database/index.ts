import Database from 'better-sqlite3';
import { config } from '../config';
import { UserSettings, TradePosition, LearningData, RunnerPattern } from '../types';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

class DatabaseManager {
  private db: Database.Database;

  constructor() {
    const dbDir = path.dirname(config.database.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(config.database.path);
    this.initialize();
  }

  private initialize() {
    // Users table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        preset TEXT DEFAULT 'balanced',
        paper_trading INTEGER DEFAULT 1,
        auto_trade INTEGER DEFAULT 0,
        alert_threshold REAL DEFAULT 0.7,
        notifications_enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

    logger.info('Database initialized successfully');
  }

  getUserSettings(userId: number): UserSettings | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE user_id = ?');
    const row = stmt.get(userId) as any;

    if (!row) return null;

    return {
      userId: row.user_id,
      preset: row.preset,
      paperTrading: row.paper_trading === 1,
      autoTrade: row.auto_trade === 1,
      alertThreshold: row.alert_threshold,
      notificationsEnabled: row.notifications_enabled === 1,
      customPatterns: [],
    };
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
      0, // Default user, will be updated for multi-user
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

  close(): void {
    this.db.close();
  }
}

export default new DatabaseManager();
