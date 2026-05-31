#!/usr/bin/env node
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

if (process.env.NODE_ENV !== "development") {
  console.error(
    "Seeding is allowed only in development environment. Set NODE_ENV=development to proceed.",
  );
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

async function insertTransaction(
  ref: string,
  type: string,
  amount: number,
  phone: string,
  provider: string,
  stellar: string,
  status: string,
  userId: string | null,
) {
  await pool.query(
    `INSERT INTO transactions (reference_number, type, amount, phone_number, provider, stellar_address, status, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (reference_number) DO NOTHING`,
    [ref, type, amount, phone, provider, stellar, status, userId],
  );
}

async function seed() {
  console.log("Starting DB seed (development only)");

  try {
    // Create sample users
    const users = [
      { phone: "+111111111", kyc: "unverified" },
      { phone: "+222222222", kyc: "basic" },
      { phone: "+333333333", kyc: "full" },
    ];

    const userIds: Record<string, string> = {};
    for (const u of users) {
      const id = await upsertUser(u.phone, u.kyc);
      userIds[u.phone] = id;
      console.log(`Upserted user ${u.phone} -> ${id}`);
    }

    // Transactions: 10 completed, 5 pending, 3 failed
    const providers = ["mtn", "airtel", "orange"];
    const statuses = [
      ...Array(10).fill("completed"),
      ...Array(5).fill("pending"),
      ...Array(3).fill("failed"),
    ];

    let counter = 1;
    for (const status of statuses) {
      const provider = providers[counter % providers.length];
      const phone = users[counter % users.length].phone;
      const amount = Math.floor(Math.random() * 9000) + 100; // between 100 and 9100
      const ref = `SEED-${counter}-${provider.toUpperCase()}`;
      const stellar = `GSEED${String(counter).padStart(52, "0").slice(0, 56)}`;
      await insertTransaction(
        ref,
        "deposit",
        amount,
        phone,
        provider,
        stellar,
        status,
        userIds[phone],
      );
      counter++;
    }

    console.log("Seeding complete.");
  } catch (err) {
    console.error("Seeding failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
