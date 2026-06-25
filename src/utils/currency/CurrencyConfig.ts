import logger from "../logger";
/**
 * CurrencyConfig - Configuration manager for currency formatting rules
 * Manages currency-specific formatting rules and validation
 */

import { CurrencyRule, CurrencyConfiguration } from './types';
import { DEFAULT_CONFIG } from './constants';

/**
 * Configuration manager for currency formatting rules
 */
export class CurrencyConfig {
  private static configuration: CurrencyConfiguration = DEFAULT_CONFIG;
  private static isInitialized: boolean = false;
  private static initializationErrors: string[] = [];

  /**
   * Initialize and validate the configuration
   * This method is called automatically when the class is first used
   * @param config - Optional configuration to validate and use
   */
  private static initialize(config?: CurrencyConfiguration): void {
    if (this.isInitialized) {
      return;
    }

    this.initializationErrors = [];
    
    try {
      const configToValidate = config || DEFAULT_CONFIG;
      
      // Validate the configuration structure
      this.validateConfiguration(configToValidate);
      
      // If validation passes, use the configuration
      this.configuration = this.createSafeConfiguration(configToValidate);
      this.isInitialized = true;
      
      if (this.initializationErrors.length > 0) {
        console.warn('Currency configuration initialized with warnings:', this.initializationErrors);
      }
    } catch (error) {
      // If validation fails completely, use safe defaults and log error
      logger.error('Currency configuration validation failed, using safe defaults:', error);
      this.configuration = this.createSafeConfiguration(DEFAULT_CONFIG);
      this.isInitialized = true;
      this.initializationErrors.push(`Configuration validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate a complete configuration object
   * @param config - Configuration to validate
   * @throws Error if configuration is fundamentally invalid
   */
  private static validateConfiguration(config: CurrencyConfiguration): void {
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration must be a valid object');
    }

    // Validate currencies object
    if (!config.currencies || typeof config.currencies !== 'object') {
      throw new Error('Configuration must have a currencies object');
    }

    // Validate settings object
    if (!config.settings || typeof config.settings !== 'object') {
      throw new Error('Configuration must have a settings object');
    }

    // Validate each currency rule (but don't require at least one - that's handled in createSafeConfiguration)
    for (const [code, rule] of Object.entries(config.currencies)) {
      try {
        this.validateCurrencyRule(rule, code);
      } catch (error) {
        this.initializationErrors.push(`Invalid currency rule for ${code}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Validate settings
    this.validateSettings(config.settings);
  }

  /**
   * Validate a single currency rule
   * @param rule - Currency rule to validate
   * @param code - Currency code for error reporting
   */
  private static validateCurrencyRule(rule: CurrencyRule, code: string): void {
    if (!rule || typeof rule !== 'object') {
      throw new Error('Currency rule must be a valid object');
    }

    // Validate required fields
    if (!rule.code || typeof rule.code !== 'string') {
      throw new Error('Currency rule must have a valid code');
    }

    if (typeof rule.numericCode !== 'number' || rule.numericCode <= 0) {
      throw new Error('Currency rule must have a valid numeric code');
    }

    if (typeof rule.minorUnits !== 'number' || rule.minorUnits < 0) {
      throw new Error('Currency rule must have valid minor units (>= 0)');
    }

    if (!rule.symbol || typeof rule.symbol !== 'string') {
      throw new Error('Currency rule must have a valid symbol');
    }

    if (!rule.name || typeof rule.name !== 'string') {
      throw new Error('Currency rule must have a valid name');
    }

    // Validate formatting configuration
    if (!rule.formatting || typeof rule.formatting !== 'object') {
      throw new Error('Currency rule must have valid formatting configuration');
    }

    if (!rule.formatting.locale || typeof rule.formatting.locale !== 'string') {
      throw new Error('Currency rule must have a valid locale');
    }

    if (rule.formatting.style !== 'currency') {
      throw new Error('Currency rule formatting style must be "currency"');
    }

    if (typeof rule.formatting.useGrouping !== 'boolean') {
      throw new Error('Currency rule must specify useGrouping as boolean');
    }

    if (!['round', 'floor', 'ceil'].includes(rule.formatting.roundingMode)) {
      throw new Error('Currency rule must have valid rounding mode (round, floor, or ceil)');
    }

    // Validate validation configuration
    if (!rule.validation || typeof rule.validation !== 'object') {
      throw new Error('Currency rule must have valid validation configuration');
    }

    if (typeof rule.validation.minValue !== 'number') {
      throw new Error('Currency rule must have valid minValue');
    }

    if (typeof rule.validation.maxValue !== 'number') {
      throw new Error('Currency rule must have valid maxValue');
    }

    if (rule.validation.minValue >= rule.validation.maxValue) {
      throw new Error('Currency rule minValue must be less than maxValue');
    }

    if (typeof rule.validation.precision !== 'number' || rule.validation.precision < 0) {
      throw new Error('Currency rule must have valid precision (>= 0)');
    }
  }

  /**
   * Validate configuration settings
   * @param settings - Settings to validate
   */
  private static validateSettings(settings: CurrencyConfiguration['settings']): void {
    if (!settings.defaultCurrency || typeof settings.defaultCurrency !== 'string') {
      this.initializationErrors.push('Invalid defaultCurrency in settings, using USD');
      console.warn('Invalid defaultCurrency in settings, using USD');
    }

    if (!settings.defaultLocale || typeof settings.defaultLocale !== 'string') {
      this.initializationErrors.push('Invalid defaultLocale in settings, using en-US');
      console.warn('Invalid defaultLocale in settings, using en-US');
    }

    if (typeof settings.cacheSize !== 'number' || settings.cacheSize <= 0) {
      this.initializationErrors.push('Invalid cacheSize in settings, using default 100');
      console.warn('Invalid cacheSize in settings, using default 100');
    }

    if (typeof settings.performanceThreshold !== 'number' || settings.performanceThreshold <= 0) {
      this.initializationErrors.push('Invalid performanceThreshold in settings, using default 10ms');
      console.warn('Invalid performanceThreshold in settings, using default 10ms');
    }
  }

  /**
   * Create a safe configuration with fallbacks for invalid values
   * @param config - Configuration to make safe
   * @returns Safe configuration with fallbacks applied
   */
  private static createSafeConfiguration(config: CurrencyConfiguration): CurrencyConfiguration {
    const safeConfig: CurrencyConfiguration = {
      currencies: {},
      settings: {
        defaultCurrency: 'USD',
        defaultLocale: 'en-US',
        cacheSize: 100,
        performanceThreshold: 10
      }
    };

    // Copy valid currencies, skip invalid ones
    for (const [code, rule] of Object.entries(config.currencies)) {
      try {
        this.validateCurrencyRule(rule, code);
        safeConfig.currencies[code] = { ...rule };
      } catch (error) {
        console.warn(`Skipping invalid currency rule for ${code}:`, error);
        this.initializationErrors.push(`Skipped invalid currency ${code}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Ensure we have at least the default currencies
    if (Object.keys(safeConfig.currencies).length === 0) {
      console.warn('No valid currencies found, using default currencies');
      safeConfig.currencies = { ...DEFAULT_CONFIG.currencies };
      this.initializationErrors.push('No valid currencies found, using default currencies');
    }

    // Apply safe settings with fallbacks
    if (config.settings) {
      safeConfig.settings = {
        defaultCurrency: (typeof config.settings.defaultCurrency === 'string' && config.settings.defaultCurrency) 
          ? config.settings.defaultCurrency 
          : 'USD',
        defaultLocale: (typeof config.settings.defaultLocale === 'string' && config.settings.defaultLocale) 
          ? config.settings.defaultLocale 
          : 'en-US',
        cacheSize: (typeof config.settings.cacheSize === 'number' && config.settings.cacheSize > 0) 
          ? config.settings.cacheSize 
          : 100,
        performanceThreshold: (typeof config.settings.performanceThreshold === 'number' && config.settings.performanceThreshold > 0) 
          ? config.settings.performanceThreshold 
          : 10
      };
    }

    return safeConfig;
  }

  /**
   * Get initialization errors that occurred during configuration loading
   * @returns Array of initialization error messages
   */
  static getInitializationErrors(): string[] {
    this.initialize();
    return [...this.initializationErrors];
  }

  /**
   * Check if configuration was initialized successfully
   * @returns True if initialization was successful without errors
   */
  static isConfigurationValid(): boolean {
    this.initialize();
    return this.initializationErrors.length === 0;
  }

  /**
   * Reinitialize with a new configuration
   * @param config - New configuration to validate and use
   */
  static reinitialize(config: CurrencyConfiguration): void {
    this.isInitialized = false;
    this.initialize(config);
  }

  /**
   * Get currency rule for a specific currency code
   * @param currencyCode - ISO 4217 currency code
   * @returns Currency rule configuration
   * @throws Error if currency code is not supported
   */
  static getCurrencyRule(currencyCode: string): CurrencyRule {
    this.initialize();
    
    if (!currencyCode || typeof currencyCode !== 'string') {
      throw new Error('Currency code must be a non-empty string');
    }

    const normalizedCode = currencyCode.toUpperCase();
    const rule = this.configuration.currencies[normalizedCode];
    
    if (!rule) {
      throw new Error(`Unsupported currency code: ${currencyCode}. Supported currencies: ${Object.keys(this.configuration.currencies).join(', ')}`);
    }

    return rule;
  }

  /**
   * Check if a currency code is supported
   * @param currencyCode - Currency code to check
   * @returns True if currency is supported
   */
  static isSupported(currencyCode: string): boolean {
    this.initialize();
    
    if (!currencyCode || typeof currencyCode !== 'string') {
      return false;
    }

    const normalizedCode = currencyCode.toUpperCase();
    return normalizedCode in this.configuration.currencies;
  }

  /**
   * Add a new currency rule
   * @param rule - Currency rule to add
   * @throws Error if rule is invalid or currency already exists
   */
  static addCurrency(rule: CurrencyRule): void {
    this.initialize();
    
    if (!rule || typeof rule !== 'object') {
      throw new Error('Currency rule must be a valid object');
    }

    // Validate required fields
    if (!rule.code || typeof rule.code !== 'string') {
      throw new Error('Currency rule must have a valid code');
    }

    if (typeof rule.numericCode !== 'number' || rule.numericCode <= 0) {
      throw new Error('Currency rule must have a valid numeric code');
    }

    if (typeof rule.minorUnits !== 'number' || rule.minorUnits < 0) {
      throw new Error('Currency rule must have valid minor units (>= 0)');
    }

    if (!rule.symbol || typeof rule.symbol !== 'string') {
      throw new Error('Currency rule must have a valid symbol');
    }

    if (!rule.name || typeof rule.name !== 'string') {
      throw new Error('Currency rule must have a valid name');
    }

    // Validate formatting configuration
    if (!rule.formatting || typeof rule.formatting !== 'object') {
      throw new Error('Currency rule must have valid formatting configuration');
    }

    if (!rule.formatting.locale || typeof rule.formatting.locale !== 'string') {
      throw new Error('Currency rule must have a valid locale');
    }

    if (rule.formatting.style !== 'currency') {
      throw new Error('Currency rule formatting style must be "currency"');
    }

    if (typeof rule.formatting.useGrouping !== 'boolean') {
      throw new Error('Currency rule must specify useGrouping as boolean');
    }

    if (!['round', 'floor', 'ceil'].includes(rule.formatting.roundingMode)) {
      throw new Error('Currency rule must have valid rounding mode (round, floor, or ceil)');
    }

    // Validate validation configuration
    if (!rule.validation || typeof rule.validation !== 'object') {
      throw new Error('Currency rule must have valid validation configuration');
    }

    if (typeof rule.validation.minValue !== 'number') {
      throw new Error('Currency rule must have valid minValue');
    }

    if (typeof rule.validation.maxValue !== 'number') {
      throw new Error('Currency rule must have valid maxValue');
    }

    if (rule.validation.minValue >= rule.validation.maxValue) {
      throw new Error('Currency rule minValue must be less than maxValue');
    }

    if (typeof rule.validation.precision !== 'number' || rule.validation.precision < 0) {
      throw new Error('Currency rule must have valid precision (>= 0)');
    }

    const normalizedCode = rule.code.toUpperCase();
    
    // Check if currency already exists
    if (normalizedCode in this.configuration.currencies) {
      throw new Error(`Currency ${normalizedCode} already exists. Use updateConfiguration to modify existing currencies.`);
    }

    // Add the currency rule
    this.configuration.currencies[normalizedCode] = {
      ...rule,
      code: normalizedCode
    };
  }

  /**
   * Update configuration with partial rules
   * @param config - Partial configuration updates
   * @throws Error if updates are invalid
   */
  static updateConfiguration(config: Partial<CurrencyRule>[]): void {
    this.initialize();
    
    if (!Array.isArray(config)) {
      throw new Error('Configuration updates must be an array');
    }

    // Validate all updates before applying any
    const updates: { [code: string]: Partial<CurrencyRule> } = {};
    
    for (const update of config) {
      if (!update || typeof update !== 'object') {
        throw new Error('Each configuration update must be a valid object');
      }

      if (!update.code || typeof update.code !== 'string') {
        throw new Error('Each configuration update must have a valid code');
      }

      const normalizedCode = update.code.toUpperCase();
      
      if (!this.isSupported(normalizedCode)) {
        throw new Error(`Cannot update unsupported currency: ${update.code}`);
      }

      // Validate partial update fields if provided
      if (update.numericCode !== undefined && (typeof update.numericCode !== 'number' || update.numericCode <= 0)) {
        throw new Error(`Invalid numericCode for ${update.code}`);
      }

      if (update.minorUnits !== undefined && (typeof update.minorUnits !== 'number' || update.minorUnits < 0)) {
        throw new Error(`Invalid minorUnits for ${update.code}`);
      }

      if (update.symbol !== undefined && (!update.symbol || typeof update.symbol !== 'string')) {
        throw new Error(`Invalid symbol for ${update.code}`);
      }

      if (update.name !== undefined && (!update.name || typeof update.name !== 'string')) {
        throw new Error(`Invalid name for ${update.code}`);
      }

      if (update.formatting) {
        if (update.formatting.locale !== undefined && (!update.formatting.locale || typeof update.formatting.locale !== 'string')) {
          throw new Error(`Invalid locale for ${update.code}`);
        }

        if (update.formatting.style !== undefined && update.formatting.style !== 'currency') {
          throw new Error(`Invalid style for ${update.code}: must be "currency"`);
        }

        if (update.formatting.useGrouping !== undefined && typeof update.formatting.useGrouping !== 'boolean') {
          throw new Error(`Invalid useGrouping for ${update.code}`);
        }

        if (update.formatting.roundingMode !== undefined && !['round', 'floor', 'ceil'].includes(update.formatting.roundingMode)) {
          throw new Error(`Invalid roundingMode for ${update.code}`);
        }
      }

      if (update.validation) {
        if (update.validation.minValue !== undefined && typeof update.validation.minValue !== 'number') {
          throw new Error(`Invalid minValue for ${update.code}`);
        }

        if (update.validation.maxValue !== undefined && typeof update.validation.maxValue !== 'number') {
          throw new Error(`Invalid maxValue for ${update.code}`);
        }

        if (update.validation.precision !== undefined && (typeof update.validation.precision !== 'number' || update.validation.precision < 0)) {
          throw new Error(`Invalid precision for ${update.code}`);
        }
      }

      updates[normalizedCode] = update;
    }

    // Apply all validated updates
    for (const [code, update] of Object.entries(updates)) {
      const currentRule = this.configuration.currencies[code];
      
      // Deep merge the update with the current rule
      this.configuration.currencies[code] = {
        ...currentRule,
        ...update,
        code, // Ensure code stays normalized
        formatting: {
          ...currentRule.formatting,
          ...(update.formatting || {})
        },
        validation: {
          ...currentRule.validation,
          ...(update.validation || {})
        }
      };

      // Validate minValue < maxValue after merge
      const updatedRule = this.configuration.currencies[code];
      if (updatedRule.validation.minValue >= updatedRule.validation.maxValue) {
        throw new Error(`After update, minValue must be less than maxValue for ${code}`);
      }
    }
  }

  /**
   * Get the current configuration
   * @returns Current currency configuration
   */
  static getConfiguration(): CurrencyConfiguration {
    this.initialize();
    return this.configuration;
  }

  /**
   * Reset configuration to defaults
   */
  static resetToDefaults(): void {
    this.isInitialized = false;
    this.initializationErrors = [];
    // Create a deep copy to avoid reference issues
    this.configuration = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.isInitialized = true;
  }

  /**
   * Get all supported currency codes
   * @returns Array of supported currency codes
   */
  static getSupportedCurrencies(): string[] {
    this.initialize();
    return Object.keys(this.configuration.currencies);
  }

  /**
   * Get currency rule by numeric code
   * @param numericCode - ISO 4217 numeric code
   * @returns Currency rule configuration
   * @throws Error if numeric code is not found
   */
  static getCurrencyRuleByNumericCode(numericCode: number): CurrencyRule {
    this.initialize();
    
    if (typeof numericCode !== 'number' || numericCode <= 0) {
      throw new Error('Numeric code must be a positive number');
    }

    for (const rule of Object.values(this.configuration.currencies)) {
      if (rule.numericCode === numericCode) {
        return rule;
      }
    }

    throw new Error(`No currency found with numeric code: ${numericCode}`);
  }

  /**
   * Validate a currency amount against currency-specific rules
   * @param amount - Amount to validate
   * @param currencyCode - Currency code
   * @returns True if amount is valid for the currency
   */
  static isValidAmount(amount: number, currencyCode: string): boolean {
    this.initialize();
    
    try {
      const rule = this.getCurrencyRule(currencyCode);
      return amount >= rule.validation.minValue && 
             amount <= rule.validation.maxValue &&
             Number.isFinite(amount);
    } catch {
      return false;
    }
  }

  /**
   * Get the default locale for a currency
   * @param currencyCode - Currency code
   * @returns Default locale string
   */
  static getDefaultLocale(currencyCode: string): string {
    this.initialize();
    const rule = this.getCurrencyRule(currencyCode);
    return rule.formatting.locale;
  }

  /**
   * Get currency symbol
   * @param currencyCode - Currency code
   * @returns Currency symbol
   */
  static getCurrencySymbol(currencyCode: string): string {
    this.initialize();
    const rule = this.getCurrencyRule(currencyCode);
    return rule.symbol;
  }

  /**
   * Get currency name
   * @param currencyCode - Currency code
   * @returns Full currency name
   */
  static getCurrencyName(currencyCode: string): string {
    this.initialize();
    const rule = this.getCurrencyRule(currencyCode);
    return rule.name;
  }
}