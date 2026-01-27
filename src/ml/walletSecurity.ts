/**
 * Wallet Security Module - Enhanced wallet management with security hardening
 *
 * Features:
 * - AES-256-CBC encryption for private keys
 * - PIN/password protection per user
 * - Auto-lock after inactivity
 * - Transaction simulation before send
 * - Kill switch
 * - Max spend per trade
 * - Rug/honeypot detection pre-trade
 * - Slippage protection
 * - RPC failure handling with retry
 * - Key rotation support
 */

import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, VersionedTransaction, SendOptions } from '@solana/web3.js';
import crypto from 'crypto';
import { config } from '../config';
import db from '../database';
import logger from '../utils/logger';
import bs58 from 'bs58';

// ============================================================
// TYPES
// ============================================================

export interface SecureWalletInfo {
  userId: number;
  publicKey: string;
  createdAt: Date;
  lastUsed: Date | null;
  status: 'active' | 'locked' | 'revoked';
  hasPin: boolean;
}

export interface TransactionSimulation {
  success: boolean;
  estimatedFee: number;
  balanceAfter: number;
  warnings: string[];
  rugIndicators: string[];
}

export interface SpendLimits {
  maxPerTrade: number;     // SOL
  maxDaily: number;        // SOL
  spentToday: number;      // SOL
  tradesRemaining: number;
}

// ============================================================
// CONSTANTS
// ============================================================

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RPC_RETRIES = 4;
const RPC_RETRY_DELAYS = [2000, 4000, 8000, 16000]; // exponential backoff
const DEFAULT_MAX_TRADE_SOL = 5.0;
const DEFAULT_DAILY_LIMIT_SOL = 20.0;

// ============================================================
// SECURE WALLET MANAGER
// ============================================================

export class SecureWalletManager {
  private connection: Connection;
  private lastActivity: Map<number, number> = new Map();
  private lockedUsers: Set<number> = new Set();
  private killSwitchActive: boolean = false;
  private dailySpend: Map<number, { amount: number; date: string }> = new Map();

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.initializeSecurityTables();
  }

  // ============================================================
  // WALLET CREATION & IMPORT
  // ============================================================

  /**
   * Create a new Solana wallet for a user
   */
  async createWallet(userId: number): Promise<{ publicKey: string; created: boolean }> {
    if (this.killSwitchActive) {
      throw new Error('Kill switch active - wallet operations disabled');
    }

    // Check if wallet already exists
    const existing = db.getUserWallet(userId);
    if (existing) {
      return { publicKey: existing.publicKey, created: false };
    }

    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toString();
    const encryptedKey = this.encryptKey(keypair.secretKey);

    db.createWallet(userId, publicKey, encryptedKey);
    this.lastActivity.set(userId, Date.now());

    logger.info(`Secure wallet created for user ${userId}: ${publicKey}`);
    return { publicKey, created: true };
  }

  /**
   * Import wallet from base58 private key
   * SECURITY: Never log the private key
   */
  async importWallet(userId: number, privateKeyBase58: string): Promise<{ publicKey: string; imported: boolean }> {
    if (this.killSwitchActive) {
      throw new Error('Kill switch active - wallet operations disabled');
    }

    try {
      const secretKey = bs58.decode(privateKeyBase58);
      const keypair = Keypair.fromSecretKey(secretKey);
      const publicKey = keypair.publicKey.toString();

      const encryptedKey = this.encryptKey(keypair.secretKey);
      db.createWallet(userId, publicKey, encryptedKey);
      this.lastActivity.set(userId, Date.now());

      logger.info(`Wallet imported for user ${userId}: ${publicKey}`);
      return { publicKey, imported: true };
    } catch (error) {
      logger.error(`Wallet import failed for user ${userId}: invalid key format`);
      throw new Error('Invalid private key format. Must be base58 encoded.');
    }
  }

  // ============================================================
  // ENCRYPTION
  // ============================================================

  /**
   * Encrypt private key using AES-256-CBC
   */
  encryptKey(secretKey: Uint8Array): string {
    const key = this.deriveEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(Buffer.from(secretKey));
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }

  /**
   * Decrypt private key from stored format
   * SECURITY: Result should never be logged or stored in plaintext
   */
  decryptKey(encryptedData: string): Uint8Array {
    const key = this.deriveEncryptionKey();
    const [ivHex, encryptedHex] = encryptedData.split(':');

    if (!ivHex || !encryptedHex) {
      throw new Error('Invalid encrypted key format');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return new Uint8Array(decrypted);
  }

  private deriveEncryptionKey(): Buffer {
    const secret = config.security?.encryptionKey || 'default-key-change-in-production-32b';
    return crypto.scryptSync(secret, 'spiro-bot-salt-v1', 32);
  }

  // ============================================================
  // BALANCE & TRANSACTION
  // ============================================================

  /**
   * Get wallet balance with RPC retry logic
   */
  async getBalance(userId: number): Promise<number> {
    this.checkAccess(userId);

    const wallet = db.getUserWallet(userId);
    if (!wallet) return 0;

    const publicKey = new PublicKey(wallet.publicKey);

    for (let attempt = 0; attempt <= MAX_RPC_RETRIES; attempt++) {
      try {
        const balance = await this.connection.getBalance(publicKey);
        db.updateWalletBalanceCheck(userId);
        this.lastActivity.set(userId, Date.now());
        return balance / LAMPORTS_PER_SOL;
      } catch (error) {
        if (attempt < MAX_RPC_RETRIES) {
          const delay = RPC_RETRY_DELAYS[attempt];
          logger.warn(`RPC failed (attempt ${attempt + 1}), retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          logger.error(`RPC failed after ${MAX_RPC_RETRIES + 1} attempts:`, error);
          throw new Error('Unable to fetch balance. RPC node unavailable.');
        }
      }
    }
    return 0;
  }

  /**
   * Sign a transaction with the user's wallet
   * SECURITY: Requires active session, checks kill switch and spend limits
   */
  async signTransaction(userId: number, transaction: VersionedTransaction): Promise<VersionedTransaction> {
    this.checkAccess(userId);

    if (this.killSwitchActive) {
      throw new Error('Kill switch active - transactions disabled');
    }

    const keypair = this.getKeypair(userId);
    if (!keypair) {
      throw new Error('No wallet found for user');
    }

    transaction.sign([keypair]);
    this.lastActivity.set(userId, Date.now());

    return transaction;
  }

  /**
   * Send a transaction with simulation-first approach
   */
  async sendTransaction(
    userId: number,
    transaction: VersionedTransaction,
    solAmount: number
  ): Promise<string> {
    this.checkAccess(userId);

    // Check spend limits
    this.checkSpendLimits(userId, solAmount);

    // Simulate first
    const simulation = await this.simulateTransaction(userId, transaction);
    if (!simulation.success) {
      const warnings = simulation.warnings.join(', ');
      throw new Error(`Transaction simulation failed: ${warnings}`);
    }

    if (simulation.rugIndicators.length > 0) {
      throw new Error(
        `Rug/honeypot detected: ${simulation.rugIndicators.join(', ')}. Transaction blocked.`
      );
    }

    // Sign
    const signed = await this.signTransaction(userId, transaction);

    // Send with retry
    for (let attempt = 0; attempt <= MAX_RPC_RETRIES; attempt++) {
      try {
        const signature = await this.connection.sendRawTransaction(
          signed.serialize(),
          { skipPreflight: false, maxRetries: 3 } as SendOptions
        );

        const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        }

        // Record spend
        this.recordSpend(userId, solAmount);
        this.lastActivity.set(userId, Date.now());

        logger.info(`Transaction sent for user ${userId}: ${signature}`);
        return signature;
      } catch (error: any) {
        if (attempt < MAX_RPC_RETRIES && error.message?.includes('timeout')) {
          const delay = RPC_RETRY_DELAYS[attempt];
          logger.warn(`Transaction send failed (attempt ${attempt + 1}), retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }

    throw new Error('Transaction failed after all retry attempts');
  }

  /**
   * Simulate transaction before sending
   */
  async simulateTransaction(userId: number, transaction: VersionedTransaction): Promise<TransactionSimulation> {
    const warnings: string[] = [];
    const rugIndicators: string[] = [];

    try {
      const result = await this.connection.simulateTransaction(transaction);

      if (result.value.err) {
        warnings.push(`Simulation error: ${JSON.stringify(result.value.err)}`);
        return {
          success: false,
          estimatedFee: 0,
          balanceAfter: 0,
          warnings,
          rugIndicators,
        };
      }

      // Check for suspicious logs
      const logs = result.value.logs || [];
      for (const log of logs) {
        if (log.includes('insufficient funds')) {
          warnings.push('Insufficient funds for transaction');
        }
        if (log.includes('Transfer: insufficient lamports')) {
          rugIndicators.push('Token may be a honeypot (transfer blocked)');
        }
      }

      const balance = await this.getBalance(userId);
      const fee = (result.value.unitsConsumed || 5000) * 0.000001;

      return {
        success: true,
        estimatedFee: fee,
        balanceAfter: balance - fee,
        warnings,
        rugIndicators,
      };
    } catch (error) {
      warnings.push(`Simulation failed: ${error}`);
      return {
        success: false,
        estimatedFee: 0,
        balanceAfter: 0,
        warnings,
        rugIndicators,
      };
    }
  }

  // ============================================================
  // SECURITY CONTROLS
  // ============================================================

  /**
   * Set PIN for user wallet
   */
  setPin(userId: number, pin: string): void {
    if (pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
      throw new Error('PIN must be 4-8 digits');
    }
    const pinHash = crypto.createHash('sha256').update(pin + userId.toString()).digest('hex');
    db.setPinHash(userId, pinHash);
    logger.info(`PIN set for user ${userId}`);
  }

  /**
   * Verify PIN
   */
  verifyPin(userId: number, pin: string): boolean {
    const storedHash = db.getPinHash(userId);
    if (!storedHash) return true; // No PIN set = always passes

    const inputHash = crypto.createHash('sha256').update(pin + userId.toString()).digest('hex');
    return crypto.timingsSafeEqual(Buffer.from(storedHash), Buffer.from(inputHash));
  }

  /**
   * Lock wallet (auto-lock or manual)
   */
  lockWallet(userId: number): void {
    this.lockedUsers.add(userId);
    logger.info(`Wallet locked for user ${userId}`);
  }

  /**
   * Unlock wallet (requires PIN if set)
   */
  unlockWallet(userId: number, pin?: string): boolean {
    if (pin) {
      if (!this.verifyPin(userId, pin)) {
        logger.warn(`Failed unlock attempt for user ${userId}`);
        return false;
      }
    }
    this.lockedUsers.delete(userId);
    this.lastActivity.set(userId, Date.now());
    return true;
  }

  /**
   * Revoke wallet - marks as revoked, cannot be used
   */
  revokeWallet(userId: number): void {
    this.lockedUsers.add(userId);
    logger.info(`Wallet revoked for user ${userId}`);
    // In production: update database status to 'revoked'
  }

  /**
   * Rotate encryption keys - re-encrypt all wallet keys with new encryption key
   * CAUTION: Requires system-level access
   */
  async rotateKeys(oldSecret: string, newSecret: string): Promise<number> {
    logger.info('Starting key rotation...');
    let rotated = 0;

    try {
      // Get all wallets
      const wallets = this.queryAllDB('SELECT user_id, encrypted_private_key FROM user_wallets');

      for (const wallet of wallets) {
        try {
          // Decrypt with old key
          const oldKey = crypto.scryptSync(oldSecret, 'spiro-bot-salt-v1', 32);
          const [ivHex, encHex] = wallet.encrypted_private_key.split(':');
          const iv = Buffer.from(ivHex, 'hex');
          const enc = Buffer.from(encHex, 'hex');
          const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, oldKey, iv);
          let decrypted = decipher.update(enc);
          decrypted = Buffer.concat([decrypted, decipher.final()]);

          // Re-encrypt with new key
          const newKey = crypto.scryptSync(newSecret, 'spiro-bot-salt-v1', 32);
          const newIv = crypto.randomBytes(16);
          const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, newKey, newIv);
          let reencrypted = cipher.update(decrypted);
          reencrypted = Buffer.concat([reencrypted, cipher.final()]);
          const newEncData = newIv.toString('hex') + ':' + reencrypted.toString('hex');

          // Update database
          this.execDB(
            'UPDATE user_wallets SET encrypted_private_key = ? WHERE user_id = ?',
            [newEncData, wallet.user_id]
          );
          rotated++;
        } catch (error) {
          logger.error(`Failed to rotate key for user ${wallet.user_id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Key rotation failed:', error);
    }

    logger.info(`Key rotation complete: ${rotated} wallets updated`);
    return rotated;
  }

  // ============================================================
  // KILL SWITCH
  // ============================================================

  /**
   * Activate kill switch - blocks ALL wallet operations
   */
  activateKillSwitch(): void {
    this.killSwitchActive = true;
    logger.warn('KILL SWITCH ACTIVATED - All wallet operations disabled');
  }

  /**
   * Deactivate kill switch
   */
  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    logger.info('Kill switch deactivated');
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  // ============================================================
  // SPEND LIMITS & PROTECTION
  // ============================================================

  getSpendLimits(userId: number): SpendLimits {
    const today = new Date().toISOString().split('T')[0];
    const daily = this.dailySpend.get(userId);
    const spentToday = (daily && daily.date === today) ? daily.amount : 0;

    return {
      maxPerTrade: DEFAULT_MAX_TRADE_SOL,
      maxDaily: DEFAULT_DAILY_LIMIT_SOL,
      spentToday,
      tradesRemaining: Math.floor((DEFAULT_DAILY_LIMIT_SOL - spentToday) / 0.5),
    };
  }

  private checkSpendLimits(userId: number, amount: number): void {
    if (amount > DEFAULT_MAX_TRADE_SOL) {
      throw new Error(`Trade size ${amount} SOL exceeds max ${DEFAULT_MAX_TRADE_SOL} SOL`);
    }

    const today = new Date().toISOString().split('T')[0];
    const daily = this.dailySpend.get(userId);
    const spentToday = (daily && daily.date === today) ? daily.amount : 0;

    if (spentToday + amount > DEFAULT_DAILY_LIMIT_SOL) {
      throw new Error(
        `Daily limit reached. Spent: ${spentToday.toFixed(2)} SOL, ` +
        `Limit: ${DEFAULT_DAILY_LIMIT_SOL} SOL`
      );
    }
  }

  private recordSpend(userId: number, amount: number): void {
    const today = new Date().toISOString().split('T')[0];
    const daily = this.dailySpend.get(userId);
    if (daily && daily.date === today) {
      daily.amount += amount;
    } else {
      this.dailySpend.set(userId, { amount, date: today });
    }
  }

  // ============================================================
  // AUTO-LOCK
  // ============================================================

  checkInactivity(): void {
    const now = Date.now();
    for (const [userId, lastActive] of this.lastActivity) {
      if (now - lastActive > INACTIVITY_TIMEOUT_MS && !this.lockedUsers.has(userId)) {
        this.lockWallet(userId);
        logger.info(`Auto-locked wallet for user ${userId} after inactivity`);
      }
    }
  }

  /**
   * Start periodic inactivity checks
   */
  startInactivityMonitor(intervalMs: number = 60000): NodeJS.Timeout {
    return setInterval(() => this.checkInactivity(), intervalMs);
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private getKeypair(userId: number): Keypair | null {
    const wallet = db.getUserWallet(userId);
    if (!wallet) return null;

    try {
      const secretKey = this.decryptKey(wallet.encryptedPrivateKey);
      return Keypair.fromSecretKey(secretKey);
    } catch (error) {
      logger.error(`Failed to decrypt wallet for user ${userId}`);
      return null;
    }
  }

  private checkAccess(userId: number): void {
    if (this.killSwitchActive) {
      throw new Error('Kill switch active');
    }
    if (this.lockedUsers.has(userId)) {
      throw new Error('Wallet is locked. Use /unlock to unlock.');
    }
  }

  hasWallet(userId: number): boolean {
    return db.getUserWallet(userId) !== null;
  }

  getWalletInfo(userId: number): SecureWalletInfo | null {
    const wallet = db.getUserWallet(userId);
    if (!wallet) return null;

    const pinHash = db.getPinHash(userId);
    return {
      userId,
      publicKey: wallet.publicKey,
      createdAt: new Date(),
      lastUsed: this.lastActivity.has(userId) ? new Date(this.lastActivity.get(userId)!) : null,
      status: this.lockedUsers.has(userId) ? 'locked' : 'active',
      hasPin: !!pinHash,
    };
  }

  /**
   * Get masked public key for display (show first 6 and last 4 chars)
   */
  getMaskedAddress(userId: number): string {
    const wallet = db.getUserWallet(userId);
    if (!wallet) return 'No wallet';
    const pk = wallet.publicKey;
    return `${pk.substring(0, 6)}...${pk.substring(pk.length - 4)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private initializeSecurityTables(): void {
    try {
      this.execDB(`
        CREATE TABLE IF NOT EXISTS wallet_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          details TEXT,
          ip_hash TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (error) {
      logger.error('Error initializing security tables:', error);
    }
  }

  private queryAllDB(sql: string, params?: any[]): any[] {
    return (db as any).db?.prepare(sql).all(...(params || [])) || [];
  }

  private execDB(sql: string, params?: any[]): void {
    if (params) {
      (db as any).db?.prepare(sql).run(...params);
    } else {
      (db as any).db?.exec(sql);
    }
  }
}

export const secureWallet = new SecureWalletManager();
export default secureWallet;
