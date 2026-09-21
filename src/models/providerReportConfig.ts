/**
 * Provider Report Configuration Model
 *
 * Persistence layer for the per-provider report-download credentials used by
 * the reconciliation job (MTN / Airtel / Orange).
 *
 * Issue #2031: provider API keys and secrets are AES-256-GCM encrypted at rest
 * and decrypted transparently whenever a configuration is loaded, so callers
 * (and the reconciliation service) always receive plaintext credentials while
 * the database only ever holds ciphertext.
 */

import { queryRead, queryWrite } from "../config/database";
import { encryptModelFields, decryptModelFields } from "../utils/crypto";

/** Columns that hold provider credentials and must be encrypted at rest. */
const CREDENTIAL_FIELDS = ["api_key", "api_secret"] as const;

export type ProviderDownloadMethod = "api" | "manual" | "sftp" | "email";

/** Raw shape returned by PostgreSQL. */
export interface ProviderReportConfigRow {
  id: string;
  provider: string;
  is_enabled: boolean;
  download_method: ProviderDownloadMethod;
  api_endpoint: string | null;
  api_key: string | null;
  api_secret: string | null;
  report_timezone: string | null;
  report_time_format: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

/** Public shape — credentials are decrypted before leaving the model. */
export interface ProviderReportConfig {
  id: string;
  provider: string;
  is_enabled: boolean;
  download_method: ProviderDownloadMethod;
  api_endpoint: string | null;
  api_key: string | null;
  api_secret: string | null;
  report_timezone?: string | null;
  report_time_format?: string | null;
}

export interface UpdateProviderCredentialsInput {
  provider: string;
  isEnabled?: boolean;
  downloadMethod?: ProviderDownloadMethod;
  apiEndpoint?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
}

const SELECT_COLUMNS = `
  id,
  provider,
  is_enabled,
  download_method,
  api_endpoint,
  api_key,
  api_secret,
  report_timezone,
  report_time_format
`;

export class ProviderReportConfigModel {
  /**
   * Return every enabled configuration, with credentials decrypted.
   * Optionally scoped to a single provider.
   */
  async findEnabled(provider?: string): Promise<ProviderReportConfig[]> {
    const result = provider
      ? await queryRead<ProviderReportConfigRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM provider_report_configs
            WHERE is_enabled = true AND provider = $1
            ORDER BY provider`,
          [provider],
        )
      : await queryRead<ProviderReportConfigRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM provider_report_configs
            WHERE is_enabled = true
            ORDER BY provider`,
        );

    return result.rows.map((row) => this.decryptCredentials(row));
  }

  /**
   * Return a single enabled configuration for a provider, or null.
   */
  async findEnabledByProvider(
    provider: string,
  ): Promise<ProviderReportConfig | null> {
    const configs = await this.findEnabled(provider);
    return configs[0] ?? null;
  }

  /**
   * Create or update a provider's report credentials.
   * Credentials are encrypted before the INSERT / UPDATE reaches the database.
   */
  async updateCredentials(
    input: UpdateProviderCredentialsInput,
  ): Promise<ProviderReportConfig> {
    const secured = encryptModelFields(
      {
        api_endpoint: input.apiEndpoint ?? null,
        api_key: input.apiKey ?? null,
        api_secret: input.apiSecret ?? null,
      },
      CREDENTIAL_FIELDS,
    );

    const result = await queryWrite<ProviderReportConfigRow>(
      `INSERT INTO provider_report_configs
         (provider, is_enabled, download_method, api_endpoint, api_key, api_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider) DO UPDATE SET
         is_enabled      = EXCLUDED.is_enabled,
         download_method = EXCLUDED.download_method,
         api_endpoint    = EXCLUDED.api_endpoint,
         api_key         = EXCLUDED.api_key,
         api_secret      = EXCLUDED.api_secret,
         updated_at      = CURRENT_TIMESTAMP
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.provider,
        input.isEnabled ?? false,
        input.downloadMethod ?? "manual",
        secured.api_endpoint,
        secured.api_key,
        secured.api_secret,
      ],
    );

    return this.decryptCredentials(result.rows[0]);
  }

  /** Decrypt credential columns on a raw row, preserving all other fields. */
  private decryptCredentials(
    row: ProviderReportConfigRow,
  ): ProviderReportConfig {
    return decryptModelFields(
      row as unknown as Record<string, unknown>,
      CREDENTIAL_FIELDS,
    ) as unknown as ProviderReportConfig;
  }
}

export const providerReportConfigModel = new ProviderReportConfigModel();
