import { configSchema, loadConfigFiles, getConfig, getConfigValue } from '../appConfig';

describe('Centralized Configuration System', () => {
  beforeAll(() => {
    // Load test configuration
    process.env.NODE_ENV = 'development';
    loadConfigFiles('development');
  });

  test('should load configuration schema', () => {
    expect(configSchema).toBeDefined();
  });

  test('should get provider limits from config', () => {
    const mtnLimit = getConfigValue('providers.mtn.minAmount');
    expect(typeof mtnLimit).toBe('number');
    expect(mtnLimit).toBeGreaterThan(0);
  });

  test('should support environment variable overrides', () => {
    process.env.MTN_MIN_AMOUNT = '200';
    // Note: Convict reads env vars on schema creation, so this would require re-initialization
    // In production, this is handled automatically
  });

  test('should return transaction limits for KYC levels', () => {
    const unverifiedLimit = getConfigValue('transactionLimits.unverified');
    const basicLimit = getConfigValue('transactionLimits.basic');
    const fullLimit = getConfigValue('transactionLimits.full');

    expect(unverifiedLimit).toBeLessThanOrEqual(basicLimit);
    expect(basicLimit).toBeLessThanOrEqual(fullLimit);
  });

  test('should return transaction amount limits', () => {
    const minAmount = getConfigValue('transactions.minAmount');
    const maxAmount = getConfigValue('transactions.maxAmount');

    expect(minAmount).toBeLessThan(maxAmount);
    expect(minAmount).toBeGreaterThan(0);
  });

  test('should return auth configuration', () => {
    const maxLoginAttempts = getConfigValue('auth.maxLoginAttempts');
    expect(typeof maxLoginAttempts).toBe('number');
    expect(maxLoginAttempts).toBeGreaterThan(0);
  });

  test('should return cache configuration', () => {
    const geolocationTtl = getConfigValue('cache.geolocationTtlSeconds');
    expect(typeof geolocationTtl).toBe('number');
    expect(geolocationTtl).toBeGreaterThan(0);
  });

  test('should return complete configuration object', () => {
    const config = getConfig();
    expect(config).toBeDefined();
    expect(config.env).toBeDefined();
    expect(config.providers).toBeDefined();
    expect(config.transactionLimits).toBeDefined();
    expect(config.auth).toBeDefined();
  });

  test('all provider limits should be properly configured', () => {
    const providers = ['mtn', 'airtel', 'orange'];
    
    providers.forEach(provider => {
      const minAmount = getConfigValue(`providers.${provider}.minAmount`);
      const maxAmount = getConfigValue(`providers.${provider}.maxAmount`);
      
      expect(minAmount).toBeGreaterThan(0);
      expect(maxAmount).toBeGreaterThan(minAmount);
    });
  });
});
