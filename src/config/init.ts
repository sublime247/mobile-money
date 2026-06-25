import logger from "../utils/logger";
/**
 * Configuration Initialization Module
 * 
 * This module initializes the centralized configuration system.
 * It should be imported early in the application lifecycle.
 */

import { configSchema, loadConfigFiles, validateConfig } from './appConfig';

// Initialize config when this module is imported
const env = process.env.NODE_ENV || 'development';

try {
  // Load environment-specific and local config files
  loadConfigFiles(env);
  
  // Validate the configuration
  validateConfig();
  
  console.log(`[Config] Initialized with environment: ${env}`);
} catch (error) {
  logger.error('[Config] Failed to initialize configuration:', error);
  process.exit(1);
}

export default configSchema;
