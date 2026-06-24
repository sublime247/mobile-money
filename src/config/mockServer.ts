/**
 * Mock Provider Server Configuration
 * 
 * Configuration for the mock provider server used in development and testing.
 * Includes settings for webhook latency simulation to test realistic scenarios
 * where webhook callbacks arrive with delays.
 */

/**
 * Configuration for mock server webhook latency simulation
 */
export const mockServerConfig = {
  /**
   * Webhook latency in milliseconds - delay before firing webhook callbacks
   * to simulate realistic network latency and provider behavior.
   * 
   * Defaults to 3000ms (3 seconds) unless overridden by MOCK_WEBHOOK_LATENCY_MS env var.
   * @default 3000
   */
  webhookLatencyMs: (() => {
    const value = process.env.MOCK_WEBHOOK_LATENCY_MS;
    if (!value) return 3000;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3000;
  })(),

  /**
   * Whether webhook latency simulation is enabled.
   * When false, webhooks fire immediately without delay.
   * 
   * Defaults to true unless overridden by MOCK_WEBHOOK_LATENCY_ENABLED env var.
   * @default true
   */
  webhookLatencyEnabled: (() => {
    const value = process.env.MOCK_WEBHOOK_LATENCY_ENABLED;
    if (value === undefined || value === '') return true;
    return value.toLowerCase() === 'true' || value === '1';
  })(),
};

export default mockServerConfig;
