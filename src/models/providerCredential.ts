import { queryRead, queryWrite } from "../config/database";
import {
  decryptSecret,
  encryptSecret,
  EnvelopeEncryptedSecret,
} from "../utils/encryption";

/**
 * Provider credentials (#2295): third-party mobile money API keys/secrets and
 * Stellar distributor secret keys, encrypted at rest.
 *
 * Encryption is transparent to callers: `toEncryptedColumns` (before save)
 * envelope-encrypts the plaintext and `decryptRow` (on read) reverses it, so
 * plaintext exists only in memory. The record's provider and credential name
 * are bound into the ciphertext, so a value copied onto another row will not
 * decrypt.
 */

export interface ProviderCredential {
  id: string;
  provider: string;
  credentialName: string;
  value: string;
  keyVersion: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Credential metadata without the decrypted value, for listings. */
export type ProviderCredentialSummary = Omit<ProviderCredential, "value">;

export interface ProviderCredentialRow {
  id: string;
  provider: string;
  credential_name: string;
  encrypted_value: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  encrypted_dek: Buffer;
  dek_iv: Buffer;
  dek_auth_tag: Buffer;
  key_version: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SUMMARY_COLUMNS = `id, provider, credential_name, key_version,
  created_by, updated_by, created_at, updated_at`;

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** AAD binding a ciphertext to its record identity. */
export function credentialContext(
  provider: string,
  credentialName: string,
): string {
  return `provider_credentials:${normalizeProvider(provider)}:${credentialName}`;
}

/** Before-save hook: plaintext → encrypted column values. */
export function toEncryptedColumns(
  provider: string,
  credentialName: string,
  value: string,
): EnvelopeEncryptedSecret {
  return encryptSecret(value, credentialContext(provider, credentialName));
}

/** On-read hook: encrypted row → decrypted credential. */
export function decryptRow(row: ProviderCredentialRow): ProviderCredential {
  const value = decryptSecret(
    {
      ciphertext: row.encrypted_value,
      iv: row.iv,
      authTag: row.auth_tag,
      encryptedDek: row.encrypted_dek,
      dekIv: row.dek_iv,
      dekAuthTag: row.dek_auth_tag,
      keyVersion: row.key_version,
    },
    credentialContext(row.provider, row.credential_name),
  );
  return { ...mapSummary(row), value };
}

function mapSummary(
  row: Pick<
    ProviderCredentialRow,
    | "id"
    | "provider"
    | "credential_name"
    | "key_version"
    | "created_by"
    | "updated_by"
    | "created_at"
    | "updated_at"
  >,
): ProviderCredentialSummary {
  return {
    id: row.id,
    provider: row.provider,
    credentialName: row.credential_name,
    keyVersion: row.key_version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class ProviderCredentialRepository {
  /** Encrypts and stores a credential, replacing any existing value. */
  async upsert(
    provider: string,
    credentialName: string,
    value: string,
    actor: string | null = null,
  ): Promise<ProviderCredentialSummary> {
    if (!value) {
      throw new Error("Credential value must not be empty");
    }
    const normalized = normalizeProvider(provider);
    const enc = toEncryptedColumns(normalized, credentialName, value);

    const res = await queryWrite<ProviderCredentialRow>(
      `INSERT INTO provider_credentials
         (provider, credential_name, encrypted_value, iv, auth_tag,
          encrypted_dek, dek_iv, dek_auth_tag, key_version,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (provider, credential_name) DO UPDATE SET
         encrypted_value = EXCLUDED.encrypted_value,
         iv              = EXCLUDED.iv,
         auth_tag        = EXCLUDED.auth_tag,
         encrypted_dek   = EXCLUDED.encrypted_dek,
         dek_iv          = EXCLUDED.dek_iv,
         dek_auth_tag    = EXCLUDED.dek_auth_tag,
         key_version     = EXCLUDED.key_version,
         updated_by      = EXCLUDED.updated_by,
         updated_at      = NOW()
       RETURNING ${SUMMARY_COLUMNS}`,
      [
        normalized,
        credentialName,
        enc.ciphertext,
        enc.iv,
        enc.authTag,
        enc.encryptedDek,
        enc.dekIv,
        enc.dekAuthTag,
        enc.keyVersion,
        actor,
      ],
    );
    return mapSummary(res.rows[0]);
  }

  /** Reads and decrypts a credential, or null if none is stored. */
  async get(
    provider: string,
    credentialName: string,
  ): Promise<ProviderCredential | null> {
    const res = await queryRead<ProviderCredentialRow>(
      `SELECT * FROM provider_credentials
       WHERE provider = $1 AND credential_name = $2`,
      [normalizeProvider(provider), credentialName],
    );
    return res.rows[0] ? decryptRow(res.rows[0]) : null;
  }

  /** Lists a provider's credentials without decrypting them. */
  async listForProvider(
    provider: string,
  ): Promise<ProviderCredentialSummary[]> {
    const res = await queryRead<ProviderCredentialRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM provider_credentials
       WHERE provider = $1
       ORDER BY credential_name ASC`,
      [normalizeProvider(provider)],
    );
    return res.rows.map(mapSummary);
  }

  async delete(provider: string, credentialName: string): Promise<boolean> {
    const res = await queryWrite(
      `DELETE FROM provider_credentials
       WHERE provider = $1 AND credential_name = $2`,
      [normalizeProvider(provider), credentialName],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

export const providerCredentialRepository = new ProviderCredentialRepository();
