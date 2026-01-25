import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import crypto from 'crypto';
import { config } from '../config';
import db from '../database';
import logger from '../utils/logger';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || 'default-key-change-in-production-32b';

class SubscriptionManager {
  private connection: Connection;
  private mainWallet: string;
  private subscriptionPrice: number;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.mainWallet = config.subscription?.mainWallet || 'EAi7pueCbhkioMb8kHtib2hrVWvTkhkPpNq4saHQfhFy';
    this.subscriptionPrice = config.subscription?.priceSol || 0.5;
  }

  /**
   * Check if user has access (admin or valid subscription)
   */
  hasAccess(userId: number, telegramUsername?: string): boolean {
    // Check if it's the free admin
    const freeAdminUsername = config.subscription?.freeAdminUsername || 'mabyconnect2000';

    if (telegramUsername && telegramUsername.toLowerCase() === freeAdminUsername.toLowerCase()) {
      return true;
    }

    return db.hasAccess(userId, telegramUsername);
  }

  /**
   * Generate a new payment wallet for subscription
   */
  async generatePaymentWallet(userId: number): Promise<{ publicKey: string; paymentId: number }> {
    // Generate new keypair for payment
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toString();

    // Encrypt the private key for storage
    const encryptedKey = this.encryptPrivateKey(keypair.secretKey);

    // Create payment record
    const paymentId = db.createSubscriptionPayment(userId, publicKey, encryptedKey);

    logger.info(`Generated payment wallet for user ${userId}: ${publicKey}`);

    return { publicKey, paymentId };
  }

  /**
   * Check if payment has been received and forward to main wallet
   */
  async checkAndProcessPayment(userId: number, paymentId: number, paymentWallet: string): Promise<{ success: boolean; message: string }> {
    try {
      // Get the payment record
      const payment = db.getPendingPayment(userId);
      if (!payment || payment.id !== paymentId) {
        return { success: false, message: 'Payment not found or already processed' };
      }

      // Check balance of payment wallet
      const publicKey = new PublicKey(paymentWallet);
      const balance = await this.connection.getBalance(publicKey);
      const balanceInSol = balance / LAMPORTS_PER_SOL;

      logger.info(`Payment wallet ${paymentWallet} balance: ${balanceInSol} SOL`);

      if (balanceInSol < this.subscriptionPrice) {
        return {
          success: false,
          message: `Insufficient payment. Received: ${balanceInSol.toFixed(4)} SOL. Required: ${this.subscriptionPrice} SOL`
        };
      }

      // Decrypt the private key
      const secretKey = this.decryptPrivateKey(payment.payment_wallet_encrypted_key);
      const paymentKeypair = Keypair.fromSecretKey(secretKey);

      // Forward funds to main wallet (minus a small amount for transaction fees)
      const mainWalletPubkey = new PublicKey(this.mainWallet);
      const amountToSend = balance - 5000; // Keep 5000 lamports for fees

      if (amountToSend > 0) {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: paymentKeypair.publicKey,
            toPubkey: mainWalletPubkey,
            lamports: amountToSend,
          })
        );

        const signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [paymentKeypair]
        );

        logger.info(`Payment forwarded to main wallet. Signature: ${signature}`);
      }

      // Confirm subscription payment
      db.confirmSubscriptionPayment(paymentId, userId);

      return {
        success: true,
        message: `Payment confirmed! ${balanceInSol.toFixed(4)} SOL received. Your subscription is now active for 30 days.`
      };
    } catch (error) {
      logger.error('Error processing payment:', error);
      return { success: false, message: 'Error processing payment. Please try again or contact support.' };
    }
  }

  /**
   * Get subscription status for a user
   */
  getSubscriptionStatus(userId: number): { isActive: boolean; expiresAt?: Date; daysRemaining?: number } {
    const settings = db.getUserSettings(userId);

    if (!settings || !settings.isSubscribed || !settings.subscriptionExpiresAt) {
      return { isActive: false };
    }

    const now = new Date();
    const expiresAt = settings.subscriptionExpiresAt;
    const isActive = now < expiresAt;
    const daysRemaining = isActive ? Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0;

    return { isActive, expiresAt, daysRemaining };
  }

  /**
   * Get subscription price
   */
  getPrice(): number {
    return this.subscriptionPrice;
  }

  /**
   * Get main wallet address
   */
  getMainWallet(): string {
    return this.mainWallet;
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
}

export default new SubscriptionManager();
