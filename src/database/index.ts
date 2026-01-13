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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_balance_check DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (user_id)
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

  close(): void {
    this.db.close();
  }
}

export default new DatabaseManager();
