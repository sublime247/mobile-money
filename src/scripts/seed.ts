#!/usr/bin/env node
import { printError } from "./momo-cli";
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

if (process.env.NODE_ENV !== "development") {
  printError("Seeding is allowed only in development environment. Set NODE_ENV=development to proceed.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function upsertUser(phone: string, kyc: string) {
  const res = await pool.query(
    `INSERT INTO users (phone_number, kyc_level) VALUES ($1, $2)
     ON CONFLICT (phone_number) DO UPDATE SET kyc_level = EXCLUDED.kyc_level
     RETURNING id`,
    [phone, kyc],
  );
  return res.rows[0].id;
}

async function insertTransaction(ref: string, type: string, amount: number, phone: string, provider: string, stellar: string, status: string, userId: string | null) {
  const res = await pool.query(
    `INSERT INTO transactions (reference_number, type, amount, phone_number, provider, stellar_address, status, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (reference_number) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`,
    [ref, type, amount, phone, provider, stellar, status, userId],
  );
  return res.rows[0].id;
}

async function upsertFeeConfig(name: string, percentage: number, min: number, max: number, userId: string) {
  await pool.query(
    `INSERT INTO fee_configurations (name, description, fee_percentage, fee_minimum, fee_maximum, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO NOTHING`,
    [name, `Automatically seeded ${name} fee configuration`, percentage, min, max, userId, userId],
  );
}

async function insertDispute(txId: string, reason: string, status: string, reportedBy: string) {
  await pool.query(
    `INSERT INTO disputes (transaction_id, reason, status, reported_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (transaction_id) WHERE status IN ('open', 'investigating') DO NOTHING`,
    [txId, reason, status, reportedBy],
  );
}

async function seed() {
  console.log("Starting DB seed (development only)");

  try {
    // 1. Create sample users with varied KYC levels
    const users = [
      { phone: "+111111111", kyc: "unverified" },
      { phone: "+222222222", kyc: "basic" },
      { phone: "+333333333", kyc: "full" },
      { phone: "+444444444", kyc: "full" },
      { phone: "+555555555", kyc: "basic" },
    ];

    const userIds: Record<string, string> = {};
    for (const u of users) {
      const id = await upsertUser(u.phone, u.kyc);
      userIds[u.phone] = id;
      console.log(`Upserted user ${u.phone} -> ${id}`);
    }

    // 2. Ensure default fee configuration exists
    const adminUser = Object.values(userIds)[0];
    await upsertFeeConfig("default", 1.5, 50, 5000, adminUser);
    await upsertFeeConfig("premium", 0.5, 10, 1000, adminUser);
    console.log("Upserted fee configurations");

    // 3. Generate a bulk of transactions
    const providers = ["mtn", "airtel", "orange"];
    const types = ["deposit", "withdraw"];
    const statuses = [
      ...Array(30).fill("completed"),
      ...Array(10).fill("pending"),
      ...Array(5).fill("failed"),
      ...Array(5).fill("cancelled"),
    ];

    console.log(`Inserting ${statuses.length} transactions...`);
    const seededTxIds: string[] = [];
    let counter = 1;

    for (const status of statuses) {
      const provider = providers[counter % providers.length];
      const user = users[counter % users.length];
      const type = types[counter % types.length];
      const amount = Math.floor(Math.random() * 9500) + 500; // between 500 and 10000
      const ref = `SEED-${counter}-${provider.toUpperCase()}`;
      const stellar = `GSEED${String(counter).padStart(52, "0").slice(0, 56)}`;

      const txId = await insertTransaction(ref, type, amount, user.phone, provider, stellar, status, userIds[user.phone]);
      seededTxIds.push(txId);
      counter++;
    }

    // 4. Create sample disputes for varied statuses
    const disputeSample = [
      { reason: "Amount mismatch on provider side", status: "open", reportedBy: "Customer" },
      { reason: "Transaction not reflected in mobile wallet", status: "investigating", reportedBy: "Customer" },
      { reason: "Double charge reported", status: "resolved", reportedBy: "Internal Audit" },
      { reason: "Incorrect mobile number provided", status: "rejected", reportedBy: "Customer" },
    ];

    console.log("Seeding disputes...");
    for (let i = 0; i < disputeSample.length; i++) {
        const txId = seededTxIds[i % seededTxIds.length];
        const d = disputeSample[i];
        await insertDispute(txId, d.reason, d.status, d.reportedBy);
    }

    console.log("Seeding complete.");
  } catch (err) {
    printError("Seeding failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();

