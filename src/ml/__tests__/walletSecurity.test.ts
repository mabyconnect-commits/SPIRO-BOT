/**
 * Unit tests for Wallet Security Module
 */

jest.mock('../../database', () => ({
  default: {
    db: {
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        all: jest.fn().mockReturnValue([]),
        run: jest.fn(),
      }),
      exec: jest.fn(),
    },
    getUserWallet: jest.fn().mockReturnValue(null),
    createWallet: jest.fn(),
    updateWalletBalanceCheck: jest.fn(),
    setPinHash: jest.fn(),
    getPinHash: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('../../utils/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../config', () => ({
  config: {
    database: { path: ':memory:' },
    security: { encryptionKey: 'test-encryption-key-32-bytes!!' },
    solana: { rpcUrl: 'https://api.mainnet-beta.solana.com' },
    trading: { paperTrading: true },
  },
}));

// Mock @solana/web3.js connection methods
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getBalance: jest.fn().mockResolvedValue(5000000000),
      simulateTransaction: jest.fn().mockResolvedValue({
        value: { err: null, logs: [], unitsConsumed: 5000 },
      }),
      sendRawTransaction: jest.fn().mockResolvedValue('mock-sig'),
      confirmTransaction: jest.fn().mockResolvedValue({ value: { err: null } }),
    })),
  };
});

import { SecureWalletManager } from '../walletSecurity';
import crypto from 'crypto';

describe('SecureWalletManager', () => {
  let manager: SecureWalletManager;

  beforeEach(() => {
    manager = new SecureWalletManager();
  });

  describe('Encryption', () => {
    test('should encrypt and decrypt a key roundtrip', () => {
      const original = crypto.randomBytes(64);
      const encrypted = manager.encryptKey(original);

      // Should be formatted as iv:ciphertext
      expect(encrypted).toContain(':');
      const [ivHex, encHex] = encrypted.split(':');
      expect(ivHex.length).toBe(32); // 16 bytes = 32 hex chars
      expect(encHex.length).toBeGreaterThan(0);

      const decrypted = manager.decryptKey(encrypted);
      expect(Buffer.from(decrypted)).toEqual(Buffer.from(original));
    });

    test('should produce different ciphertexts for same input (random IV)', () => {
      const key = crypto.randomBytes(64);
      const enc1 = manager.encryptKey(key);
      const enc2 = manager.encryptKey(key);
      expect(enc1).not.toBe(enc2); // Different IVs
    });

    test('should reject invalid encrypted format', () => {
      expect(() => manager.decryptKey('invalid-data')).toThrow();
    });
  });

  describe('Kill Switch', () => {
    test('should be inactive by default', () => {
      expect(manager.isKillSwitchActive()).toBe(false);
    });

    test('should activate and deactivate', () => {
      manager.activateKillSwitch();
      expect(manager.isKillSwitchActive()).toBe(true);

      manager.deactivateKillSwitch();
      expect(manager.isKillSwitchActive()).toBe(false);
    });

    test('should block wallet creation when active', async () => {
      manager.activateKillSwitch();
      await expect(manager.createWallet(123)).rejects.toThrow('Kill switch');
      manager.deactivateKillSwitch();
    });
  });

  describe('Wallet Locking', () => {
    test('should lock wallet', () => {
      manager.lockWallet(123);
      // getBalance should throw when locked
      expect(() => {
        (manager as any).checkAccess(123);
      }).toThrow('locked');
    });

    test('should unlock wallet without PIN when no PIN set', () => {
      manager.lockWallet(123);
      const result = manager.unlockWallet(123);
      expect(result).toBe(true);
    });
  });

  describe('Spend Limits', () => {
    test('should return default spend limits', () => {
      const limits = manager.getSpendLimits(123);
      expect(limits.maxPerTrade).toBe(5.0);
      expect(limits.maxDaily).toBe(20.0);
      expect(limits.spentToday).toBe(0);
    });

    test('should throw on trade exceeding max', () => {
      expect(() => {
        (manager as any).checkSpendLimits(123, 10.0);
      }).toThrow('exceeds max');
    });
  });

  describe('PIN Management', () => {
    test('should reject invalid PIN format', () => {
      expect(() => manager.setPin(123, '12')).toThrow('4-8 digits');
      expect(() => manager.setPin(123, 'abcd')).toThrow('4-8 digits');
      expect(() => manager.setPin(123, '123456789')).toThrow('4-8 digits');
    });

    test('should accept valid PIN format', () => {
      expect(() => manager.setPin(123, '1234')).not.toThrow();
      expect(() => manager.setPin(123, '12345678')).not.toThrow();
    });

    test('should verify PIN returns true when no PIN set', () => {
      expect(manager.verifyPin(123, '1234')).toBe(true);
    });
  });

  describe('Wallet Info', () => {
    test('should return null for non-existent wallet', () => {
      const info = manager.getWalletInfo(999);
      expect(info).toBeNull();
    });

    test('should return masked address for non-existent wallet', () => {
      const masked = manager.getMaskedAddress(999);
      expect(masked).toBe('No wallet');
    });

    test('hasWallet should return false for non-existent', () => {
      expect(manager.hasWallet(999)).toBe(false);
    });
  });

  describe('Auto-lock Inactivity', () => {
    test('should auto-lock inactive wallets', () => {
      // Simulate activity long ago
      (manager as any).lastActivity.set(123, Date.now() - 3600000); // 1 hour ago
      (manager as any).lockedUsers.delete(123);

      manager.checkInactivity();

      expect(() => {
        (manager as any).checkAccess(123);
      }).toThrow('locked');
    });

    test('should not lock recently active wallets', () => {
      (manager as any).lastActivity.set(456, Date.now());
      (manager as any).lockedUsers.delete(456);

      manager.checkInactivity();

      expect(() => {
        (manager as any).checkAccess(456);
      }).not.toThrow();
    });
  });
});
