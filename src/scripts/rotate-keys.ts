import { pool } from "../config/database";
import {
  decryptAES,
  deriveKey,
  deserializePayload,
  encryptAES,
  serializePayload,
} from "../utils/encryption";

/**
 * Columns holding secrets encrypted with the platform master key
 * (DB_ENCRYPTION_KEY). Targets missing from the schema are skipped.
 */
export const SECRET_TARGETS: ReadonlyArray<SecretColumn> = [
  { tableName: "anchored_assets", columnName: "issuer_secret_key" },
  { tableName: "anchored_assets", columnName: "distribution_secret_key" },
  { tableName: "accounting_connections", columnName: "access_token" },
  { tableName: "accounting_connections", columnName: "refresh_token" },
];

export interface RotationOptions {
  oldMasterKey: string;
  newMasterKey: string;
  dryRun?: boolean;
}

interface SecretColumn {
  tableName: string;
  columnName: string;
}

function requireKey(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} must be provided through a secure environment variable`);
  }
  return value;
}

function encryptWithKey(value: string, key: string): string {
  return serializePayload(encryptAES(value, deriveKey(key)));
}

function decryptWithKey(value: string, key: string): string {
  const parts = value.split(":");
  const payload = parts.length === 4 ? parts.slice(1).join(":") : value;
  return decryptAES(deserializePayload(payload), deriveKey(key));
}

async function findSecretColumns(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: SecretColumn[] }>;
}): Promise<SecretColumn[]> {
  const result = await client.query(
    `SELECT table_name AS "tableName", column_name AS "columnName"
     FROM information_schema.columns
     WHERE table_schema = 'public'`,
  );
  const present = new Set(
    result.rows.map((row) => `${row.tableName}.${row.columnName}`),
  );
  return SECRET_TARGETS.filter((target) =>
    present.has(`${target.tableName}.${target.columnName}`),
  );
}

export async function rotateKeys(options: RotationOptions): Promise<number> {
  if (options.oldMasterKey === options.newMasterKey) {
    throw new Error("OLD_MASTER_KEY and NEW_MASTER_KEY must be different");
  }

  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query("BEGIN");
    const columns = await findSecretColumns(client);
    const changes: Array<{ tableName: string; columnName: string; ctid: string; value: string }> = [];

    for (const { tableName, columnName } of columns) {
      const result = await client.query(
        `SELECT ctid::text AS ctid, "${columnName}" AS value
         FROM "${tableName}"
         WHERE "${columnName}" IS NOT NULL
         FOR UPDATE`,
      );
      for (const row of result.rows as Array<{ ctid: string; value: string }>) {
        const plaintext = decryptWithKey(row.value, options.oldMasterKey);
        const value = encryptWithKey(plaintext, options.newMasterKey);
        // Decrypt immediately with the new key before any write is allowed.
        if (decryptWithKey(value, options.newMasterKey) !== plaintext) {
          throw new Error(`New key verification failed for ${tableName}.${columnName}`);
        }
        changes.push({ tableName, columnName, ctid: row.ctid, value });
      }
    }

    if (!options.dryRun) {
      for (const change of changes) {
        const result = await client.query(
          `UPDATE "${change.tableName}" SET "${change.columnName}" = $1 WHERE ctid = $2::tid`,
          [change.value, change.ctid],
        );
        if (result.rowCount !== 1) {
          throw new Error(
            `Row changed during rotation in ${change.tableName}.${change.columnName}`,
          );
        }
      }

      // Re-read every stored secret and prove it decrypts with the new key
      // before committing; any failure rolls the whole rotation back.
      for (const { tableName, columnName } of columns) {
        const stored = await client.query(
          `SELECT "${columnName}" AS value FROM "${tableName}"
           WHERE "${columnName}" IS NOT NULL`,
        );
        for (const row of stored.rows as Array<{ value: string }>) {
          decryptWithKey(row.value, options.newMasterKey);
        }
      }
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    updated = changes.length;
    console.log(
      `[KeyRotation] ${options.dryRun ? "Verified" : "Rotated"} ${updated} encrypted secrets`,
    );
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await rotateKeys({
    oldMasterKey: requireKey(process.env.OLD_MASTER_KEY, "OLD_MASTER_KEY"),
    newMasterKey: requireKey(process.env.NEW_MASTER_KEY, "NEW_MASTER_KEY"),
    dryRun,
  });
}

if (process.argv[1]?.endsWith("rotate-keys.ts")) {
  main().catch((error) => {
    console.error(`[KeyRotation] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
