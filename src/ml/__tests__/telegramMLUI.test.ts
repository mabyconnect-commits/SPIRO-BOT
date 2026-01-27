/**
 * Unit tests for Telegram ML UI
 */

jest.mock('../../database', () => ({
  default: {
    db: null,
    getUserWallet: jest.fn().mockReturnValue(null),
    getPaperBalance: jest.fn().mockReturnValue(100),
    getUserSettings: jest.fn().mockReturnValue(null),
    getPatternPerformance: jest.fn().mockReturnValue({ successRate: 0, avgReturn: 0, sampleSize: 0 }),
    saveLearningData: jest.fn(),
    getRecentTradesForPattern: jest.fn().mockReturnValue([]),
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
    security: { encryptionKey: 'test-key-32-bytes-long-padding!!' },
    learning: { enabled: true, minPatternConfidence: 0.6, antiDriftThreshold: 0.15 },
    solana: { rpcUrl: 'https://api.mainnet-beta.solana.com' },
    trading: { paperTrading: true, defaultPreset: 'balanced' },
  },
  RUNNER_PATTERNS: [],
  TRADING_PRESETS: {
    balanced: {
      name: 'Balanced',
      maxPositionSizeSol: 1.5,
      minConfidence: 0.65,
      takeProfitPercentage: 150,
      stopLossPercentage: 30,
      maxOpenPositions: 7,
      riskLevel: 'balanced',
    },
  },
}));

import {
  MLMessageTemplates,
  MLCommandHandlers,
  MLCallbackRouter,
  UserFlowManager,
  UserFlowState,
} from '../telegramMLUI';

describe('MLMessageTemplates', () => {
  test('welcome message should include disclaimer', () => {
    const msg = MLMessageTemplates.welcome();
    expect(msg).toContain('Welcome');
    expect(msg).toContain('Disclaimer');
  });

  test('onboarding buttons should have 3 options', () => {
    const buttons = MLMessageTemplates.onboardingButtons();
    expect(buttons.length).toBe(3);
  });

  test('dashboard buttons should have correct layout', () => {
    const buttons = MLMessageTemplates.dashboardButtons();
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0].length).toBe(2); // Two buttons per row
  });

  test('wallet import warning should contain security info', () => {
    const msg = MLMessageTemplates.walletImportWarning();
    expect(msg).toContain('Security');
    expect(msg).toContain('AES-256');
    expect(msg).toContain('Never share');
  });

  test('trade alert should show confidence and risk', () => {
    const prediction = {
      confidenceScore: 85,
      classification: 'high_probability' as const,
      strategyRecommendation: 'aggressive',
      riskScore: 25,
      expectedROIRange: { min: 50, max: 500 },
      allowRealTrading: true,
      activeStrategies: ['Smart Money Entry'],
      disabledStrategies: [],
      explanation: 'Strong signals detected',
      featureImportance: [],
      modelAgreement: 100,
    };
    const analysis = {
      token: { symbol: 'TEST', name: 'Test', marketCap: 1000000 },
    } as any;

    const msg = MLMessageTemplates.tradeAlert(prediction, analysis);
    expect(msg).toContain('TEST');
    expect(msg).toContain('85%');
    expect(msg).toContain('25/100');
  });

  test('trade alert buttons should include execute when allowed', () => {
    const buttons = MLMessageTemplates.tradeAlertButtons('addr123', true);
    const flatTexts = buttons.flat().map(b => b.text);
    expect(flatTexts).toContain('✅ Execute Trade');
  });

  test('trade alert buttons should NOT include execute when blocked', () => {
    const buttons = MLMessageTemplates.tradeAlertButtons('addr123', false);
    const flatTexts = buttons.flat().map(b => b.text);
    expect(flatTexts).not.toContain('✅ Execute Trade');
    expect(flatTexts).toContain('🧪 Simulate Only');
  });

  test('alert templates should format correctly', () => {
    expect(MLMessageTemplates.alertNewOpportunity('TEST', 85)).toContain('TEST');
    expect(MLMessageTemplates.alertRiskDetected('TEST', 'rug')).toContain('Risk');
    expect(MLMessageTemplates.alertStrategyChange('Smart Money', 'disabled')).toContain('disabled');
    expect(MLMessageTemplates.alertLearningUpdate('retrained')).toContain('retrained');
    expect(MLMessageTemplates.alertProfitHit('TEST', 500, '5x')).toContain('500');
  });
});

describe('MLCommandHandlers', () => {
  test('handleMLStats should return text and buttons', () => {
    const result = MLCommandHandlers.handleMLStats();
    expect(result.text).toContain('ML Strategy Engine');
    expect(result.buttons.length).toBeGreaterThan(0);
  });

  test('handleTopStrategies should return strategy list', () => {
    const result = MLCommandHandlers.handleTopStrategies();
    expect(result.text).toContain('Strategies');
    expect(result.buttons.length).toBeGreaterThan(0);
  });

  test('handlePatternReport should return report', () => {
    const result = MLCommandHandlers.handlePatternReport();
    expect(result.text).toContain('Pattern');
    expect(result.buttons.length).toBeGreaterThan(0);
  });

  test('handleMLInsights should return insights', () => {
    const result = MLCommandHandlers.handleMLInsights();
    expect(result.text).toContain('ML');
    expect(result.buttons.length).toBeGreaterThan(0);
  });
});

describe('MLCallbackRouter', () => {
  test('should route ml_stats_refresh', () => {
    const result = MLCallbackRouter.route('ml_stats_refresh');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('ML');
  });

  test('should route menu_main', () => {
    const result = MLCallbackRouter.route('menu_main');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Dashboard');
  });

  test('should route menu_wallet', () => {
    const result = MLCallbackRouter.route('menu_wallet');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Wallet');
  });

  test('should route menu_settings', () => {
    const result = MLCallbackRouter.route('menu_settings');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Settings');
  });

  test('should route ml_retrain', () => {
    const result = MLCallbackRouter.route('ml_retrain');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Retrained');
  });

  test('should route trade callbacks', () => {
    expect(MLCallbackRouter.route('trade_exec_abc')).not.toBeNull();
    expect(MLCallbackRouter.route('trade_sim_abc')).not.toBeNull();
    expect(MLCallbackRouter.route('trade_skip_abc')).not.toBeNull();
  });

  test('should return null for unknown callbacks', () => {
    expect(MLCallbackRouter.route('unknown_callback')).toBeNull();
  });
});

describe('UserFlowManager', () => {
  let flowManager: UserFlowManager;

  beforeEach(() => {
    flowManager = new UserFlowManager();
  });

  test('should start in IDLE state', () => {
    expect(flowManager.getState(123)).toBe(UserFlowState.IDLE);
  });

  test('should set and get state', () => {
    flowManager.setState(123, UserFlowState.WALLET_IMPORT);
    expect(flowManager.getState(123)).toBe(UserFlowState.WALLET_IMPORT);
  });

  test('should clear state', () => {
    flowManager.setState(123, UserFlowState.WALLET_IMPORT);
    flowManager.clearState(123);
    expect(flowManager.getState(123)).toBe(UserFlowState.IDLE);
  });

  test('should process wallet import input', () => {
    flowManager.setState(123, UserFlowState.WALLET_IMPORT);
    const result = flowManager.processInput(123, 'some-private-key');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Encrypting');
    expect(flowManager.getState(123)).toBe(UserFlowState.IDLE);
  });

  test('should validate max trade size input', () => {
    flowManager.setState(123, UserFlowState.SETTING_MAX_TRADE);

    // Invalid
    const invalid = flowManager.processInput(123, 'abc');
    expect(invalid!.text).toContain('Invalid');

    // Reset state for valid test
    flowManager.setState(123, UserFlowState.SETTING_MAX_TRADE);
    const valid = flowManager.processInput(123, '2.5');
    expect(valid!.text).toContain('2.5 SOL');
  });

  test('should validate stop loss input', () => {
    flowManager.setState(123, UserFlowState.SETTING_STOP_LOSS);
    const result = flowManager.processInput(123, '25');
    expect(result!.text).toContain('25%');
  });

  test('should validate PIN input', () => {
    flowManager.setState(123, UserFlowState.ENTERING_PIN);

    // Too short
    const invalid = flowManager.processInput(123, '12');
    expect(invalid!.text).toContain('4-8 digits');

    // Valid
    flowManager.setState(123, UserFlowState.ENTERING_PIN);
    const valid = flowManager.processInput(123, '1234');
    expect(valid!.text).toContain('PIN set');
  });

  test('should return null when in IDLE state', () => {
    const result = flowManager.processInput(123, 'hello');
    expect(result).toBeNull();
  });
});
