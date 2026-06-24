import { pool } from "../src/config/database";
import { encrypt, decrypt } from "../src/utils/encryption";
import { env } from "../src/config/env";

interface ColumnConfig {
  name: string;
  deterministic?: boolean;
}

interface TableConfig {
  name: string;
  primaryKey: string;
  columns: ColumnConfig[];
}

const CONFIGS: TableConfig[] = [
  {
    name: "users",
    primaryKey: "id",
    columns: [
      { name: "phone_number", deterministic: true },
      { name: "email" },
      { name: "two_factor_secret" },
    ],
  },
  {
    name: "transactions",
    primaryKey: "id",
    columns: [
      { name: "phone_number" },
      { name: "stellar_address" },
      { name: "notes" },
      { name: "admin_notes" },
    ],
  },
  {
    name: "disputes",
    primaryKey: "id",
    columns: [
      { name: "reason" },
      { name: "resolution" },
    ],
  },
  {
    name: "dispute_notes",
    primaryKey: "id",
    columns: [
      { name: "note" },
    ],
  },
  {
    name: "travel_rule_records",
    primaryKey: "id",
    columns: [
      { name: "sender_name" },
      { name: "sender_account" },
      { name: "sender_address" },
      { name: "sender_dob" },
      { name: "sender_id_number" },
      { name: "receiver_name" },
      { name: "receiver_account" },
      { name: "receiver_address" },
    ],
  },
  {
    name: "anchored_assets",
    primaryKey: "id",
    columns: [
      { name: "issuer_secret_key" },
      { name: "distribution_secret_key" },
    ],
  },
];

const BATCH_SIZE = 100;

async function runRotation() {
  console.log("=== PII Database Key Rotation Job ===");
  console.log(`Current DB_ENCRYPTION_KEY length: ${env.DB_ENCRYPTION_KEY ? env.DB_ENCRYPTION_KEY.length : 0} chars`);
  console.log(`Fallback keys configured: ${process.env.DB_ENCRYPTION_KEYS_FALLBACK ? "Yes" : "No"}`);

  if (!env.DB_ENCRYPTION_KEY) {
    console.error("Error: DB_ENCRYPTION_KEY environment variable is not defined!");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    for (const tableConfig of CONFIGS) {
      console.log(`\nProcessing table: ${tableConfig.name}...`);
      
      // Check if table exists
      const tableCheck = await client.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
        [tableConfig.name]
      );
      if (!tableCheck.rows[0].exists) {
        console.log(`Table ${tableConfig.name} does not exist in this database, skipping.`);
        continue;
      }

      // Build SELECT query to retrieve primary key and all encrypted columns
      const selectCols = [tableConfig.primaryKey, ...tableConfig.columns.map(c => c.name)].join(", ");
      const query = `SELECT ${selectCols} FROM ${tableConfig.name}`;
      const { rows } = await client.query(query);
      console.log(`Found ${rows.length} rows to check in ${tableConfig.name}.`);

      let rotatedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      // Process in batches
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        
        // Start a transaction for the batch
        await client.query("BEGIN");
        try {
          for (const row of batch) {
            const pkVal = row[tableConfig.primaryKey];
            const updates: { col: string; val: string | null }[] = [];
            let needsUpdate = false;

            for (const colConfig of tableConfig.columns) {
              const encryptedVal = row[colConfig.name];
              if (!encryptedVal) continue;

              try {
                // Decrypt existing value using current or fallback keys
                const decrypted = decrypt(encryptedVal);
                if (decrypted === null || decrypted === undefined) continue;

                // Re-encrypt using the new active master key
                const reEncrypted = encrypt(decrypted, !!colConfig.deterministic);

                // Only perform update if ciphertext changed (i.e. if it was actually re-encrypted with a different key)
                if (reEncrypted !== encryptedVal) {
                  updates.push({ col: colConfig.name, val: reEncrypted });
                  needsUpdate = true;
                }
              } catch (err: any) {
                console.error(`[Error] Failed to decrypt/re-encrypt row ${pkVal} column ${colConfig.name} in ${tableConfig.name}:`, err.message);
                errorCount++;
              }
            }

            if (needsUpdate && updates.length > 0) {
              const setClause = updates.map((u, idx) => `${u.col} = $${idx + 2}`).join(", ");
              const params = [pkVal, ...updates.map(u => u.val)];
              const updateQuery = `UPDATE ${tableConfig.name} SET ${setClause} WHERE ${tableConfig.primaryKey} = $1`;
              await client.query(updateQuery, params);
              rotatedCount++;
            } else {
              skippedCount++;
            }
          }
          await client.query("COMMIT");
        } catch (batchErr) {
          await client.query("ROLLBACK");
          console.error(`Batch starting at index ${i} failed and was rolled back:`, batchErr);
          throw batchErr;
        }
      }

      console.log(`Table ${tableConfig.name} completed:`);
      console.log(` - Re-encrypted: ${rotatedCount} rows`);
      console.log(` - Already up-to-date: ${skippedCount} rows`);
      console.log(` - Errors: ${errorCount} fields`);
    }
    
    console.log("\n=== Key Rotation Completed Successfully ===");
  } catch (err) {
    console.error("\n[Fatal Error] Key rotation job failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runRotation();
