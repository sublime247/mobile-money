/// <reference types="jest" />

/**
 * Test setup for Currency Formatter Utility
 * Configures test environment and global test utilities
 */

// Mock console methods to reduce noise in tests unless explicitly testing logging
const originalConsole = { ...console };

beforeEach(() => {
  // Reset console mocks before each test
  console.error = jest.fn();
  console.warn = jest.fn();
  console.log = jest.fn();
  console.debug = jest.fn();
});

afterEach(() => {
  // Clear all mocks after each test
  jest.clearAllMocks();
});

afterAll(() => {
  // Restore original console methods
  Object.assign(console, originalConsole);
});

// Global test utilities for currency formatter tests
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidCurrencyFormat(): R;
      toHaveCorrectDecimalPlaces(currency: string): R;
    }
  }
}

// Custom Jest matchers for currency formatting validation
expect.extend({
  /**
   * Matcher to validate currency format structure
   */
  toBeValidCurrencyFormat(received: string) {
    const currencyRegex = /^[^\d]*[\d,]+\.?\d*[^\d]*$/;
    const pass = typeof received === 'string' && currencyRegex.test(received);
    
    return {
      message: () => 
        pass 
          ? `Expected ${received} not to be a valid currency format`
          : `Expected ${received} to be a valid currency format`,
      pass,
    };
  },

  /**
   * Matcher to validate correct decimal places for currency
   */
  toHaveCorrectDecimalPlaces(received: string, currency: string) {
    const expectedDecimals = currency === 'XAF' ? 0 : 2;
    
    // Extract decimal part
    const decimalMatch = received.match(/\.(\d+)/);
    const actualDecimals = decimalMatch ? decimalMatch[1].length : 0;
    
    const pass = actualDecimals === expectedDecimals;
    
    return {
      message: () => 
        pass 
          ? `Expected ${received} not to have ${expectedDecimals} decimal places for ${currency}`
          : `Expected ${received} to have ${expectedDecimals} decimal places for ${currency}, but got ${actualDecimals}`,
      pass,
    };
  }
});

// Test data generators for consistent test data
export const TEST_DATA = {
  VALID_AMOUNTS: [0, 0.01, 1, 10.50, 100, 1000.99, 999999999.99],
  INVALID_AMOUNTS: [NaN, Infinity, -Infinity, 'not a number', null, undefined, {}],
  SUPPORTED_CURRENCIES: ['XAF', 'GHS', 'NGN', 'USD'],
  INVALID_CURRENCIES: ['', 'XX', 'INVALID', 'EUR', 'GBP', null, undefined, 123],
  VALID_LOCALES: ['en-US', 'en-GH', 'en-NG', 'fr-CM', 'en-GB', 'fr-FR'],
  INVALID_LOCALES: ['', 'invalid', 'en', 'en-', '-US', null, undefined]
};

// Performance testing utilities
export const PERFORMANCE_HELPERS = {
  /**
   * Measure execution time of a function
   */
  measureTime: async <T>(fn: () => T | Promise<T>): Promise<{ result: T; time: number }> => {
    const start = performance.now();
    const result = await fn();
    const time = performance.now() - start;
    return { result, time };
  },

  /**
   * Run a function multiple times and get average execution time
   */
  measureAverageTime: async <T>(
    fn: () => T | Promise<T>, 
    iterations: number = 100
  ): Promise<{ averageTime: number; results: T[] }> => {
    const results: T[] = [];
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const { result, time } = await PERFORMANCE_HELPERS.measureTime(fn);
      results.push(result);
      times.push(time);
    }

    const averageTime = times.reduce((sum, time) => sum + time, 0) / times.length;
    return { averageTime, results };
  }
};