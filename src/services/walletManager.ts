import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import crypto from 'crypto';
import { config } from '../config';
import db from '../database';
import logger from '../utils/logger';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const DEFAULT_KEY = 'default-key-change-in-production-32b';
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || DEFAULT_KEY;

// Security warning for default encryption key
if (ENCRYPTION_KEY === DEFAULT_KEY) {
  logger.warn('⚠️ SECURITY WARNING: Using default encryption key! Set WALLET_ENCRYPTION_KEY in environment for production.');
}

class WalletManager {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
  }

  /**
   * Create a new wallet for a user
   */
  async createWallet(userId: number): Promise<{ publicKey: string; created: boolean }> {
    // Check if wallet already exists
    const existingWallet = db.getUserWallet(userId);
    if (existingWallet) {
      return { publicKey: existingWallet.publicKey, created: false };
    }

    // Generate new keypair
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toString();

    // Encrypt and store private key
    const encryptedPrivateKey = this.encryptPrivateKey(keypair.secretKey);
    db.createWallet(userId, publicKey, encryptedPrivateKey);

    logger.info(`Created new wallet for user ${userId}: ${publicKey}`);
    return { publicKey, created: true };
  }

  /**
   * Get user's wallet public key
   */
  getWalletAddress(userId: number): string | null {
    const wallet = db.getUserWallet(userId);
    return wallet?.publicKey || null;
  }

  /**
   * Get user's wallet balance in SOL
   */
  async getBalance(userId: number): Promise<number> {
    const wallet = db.getUserWallet(userId);
    if (!wallet) return 0;

    try {
      const publicKey = new PublicKey(wallet.publicKey);
      const balance = await this.connection.getBalance(publicKey);
      db.updateWalletBalanceCheck(userId);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error('Error fetching wallet balance:', error);
      return 0;
    }
  }

  /**
   * Get keypair for a user (for signing transactions)
   */
  getKeypair(userId: number): Keypair | null {
    const wallet = db.getUserWallet(userId);
    if (!wallet) return null;

    try {
      const secretKey = this.decryptPrivateKey(wallet.encryptedPrivateKey);
      return Keypair.fromSecretKey(secretKey);
    } catch (error) {
      logger.error('Error decrypting wallet:', error);
      return null;
    }
  }

  /**
   * Encrypt private key for storage
   */
  private encryptPrivateKey(secretKey: Uint8Array): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      ENCRYPTION_ALGORITHM,
      Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').substring(0, 32)),
      iv
    );

    let encrypted = cipher.update(Buffer.from(secretKey));
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }

  /**
   * Decrypt private key from storage
   */
  private decryptPrivateKey(encryptedData: string): Uint8Array {
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');

    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').substring(0, 32)),
      iv
    );

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return new Uint8Array(decrypted);
  }

  /**
   * Check if user has a wallet
   */
  hasWallet(userId: number): boolean {
    return db.getUserWallet(userId) !== null;
  }
}

export default new WalletManager();
