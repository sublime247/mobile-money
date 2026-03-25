import { pool } from "../config/database";
import { generateReferenceNumber } from "../utils/referenceGenerator";

export enum TransactionStatus {
  Pending = "pending",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

const MAX_TAGS = 10;
// Tags must be lowercase alphanumeric words, hyphens allowed (e.g. "refund", "high-priority")
const TAG_REGEX = /^[a-z0-9-]+$/;

function validateTags(tags: string[]): void {
  if (tags.length > MAX_TAGS)
    throw new Error(`Maximum ${MAX_TAGS} tags allowed`);
  for (const tag of tags) {
    if (!TAG_REGEX.test(tag)) throw new Error(`Invalid tag format: "${tag}"`);
  }
}

export interface Transaction {
  id: string;
  referenceNumber: string;
  type: "deposit" | "withdraw";
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  status: TransactionStatus;
  tags: string[];
  notes?: string;
  admin_notes?: string;
  createdAt: Date;
}

export class TransactionModel {
  async create(
    data: Omit<Transaction, "id" | "referenceNumber" | "createdAt">,
  ): Promise<Transaction> {
    const tags = data.tags ?? [];
    validateTags(tags);
    const referenceNumber = await generateReferenceNumber();

    const result = await pool.query(
      `INSERT INTO transactions (reference_number, type, amount, phone_number, provider, stellar_address, status, tags, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        referenceNumber,
        data.type,
        data.amount,
        data.phoneNumber,
        data.provider,
        data.stellarAddress,
        data.status,
        tags,
        data.notes ?? null,
      ],
    );
    return result.rows[0];
  }

  async findById(id: string): Promise<Transaction | null> {
    const result = await pool.query(
      "SELECT * FROM transactions WHERE id = $1",
      [id],
    );
    return result.rows[0] || null;
  }

  /** Paginated list, newest first. `limit` is capped at 100. */
  async list(limit = 50, offset = 0): Promise<Transaction[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const off = Math.max(offset, 0);
    const result = await pool.query(
      "SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [capped, off],
    );
    return result.rows;
  }

  async updateStatus(id: string, status: TransactionStatus): Promise<void> {
    await pool.query("UPDATE transactions SET status = $1 WHERE id = $2", [
      status,
      id,
    ]);
  }

  async findByReferenceNumber(
    referenceNumber: string,
  ): Promise<Transaction | null> {
    const result = await pool.query(
      "SELECT * FROM transactions WHERE reference_number = $1",
      [referenceNumber],
    );
    return result.rows[0] || null;
  }

  /**
   * Find transactions that contain ALL of the given tags.
   * Uses the GIN index on the tags column for efficient lookup.
   * @param tags - Array of tags to filter by (e.g. ["refund", "verified"])
   */
  async findByTags(tags: string[]): Promise<Transaction[]> {
    validateTags(tags);
    const result = await pool.query(
      "SELECT * FROM transactions WHERE tags @> $1",
      [tags],
    );
    return result.rows;
  }

  /**
   * Add tags to a transaction. Ignores duplicates. Max 10 tags total.
   */
  async addTags(id: string, tags: string[]): Promise<Transaction | null> {
    validateTags(tags);
    const result = await pool.query(
      `UPDATE transactions
       SET tags = (
         SELECT ARRAY(SELECT DISTINCT unnest(tags || $1::TEXT[]))
         FROM transactions WHERE id = $2
       )
       WHERE id = $2
         AND cardinality(ARRAY(SELECT DISTINCT unnest(tags || $1::TEXT[]))) <= ${MAX_TAGS}
       RETURNING *`,
      [tags, id],
    );
    return result.rows[0] || null;
  }

  /**
   * Remove tags from a transaction.
   */
  async removeTags(id: string, tags: string[]): Promise<Transaction | null> {
    const result = await pool.query(
      `UPDATE transactions
       SET tags = ARRAY(SELECT unnest(tags) EXCEPT SELECT unnest($1::TEXT[]))
       WHERE id = $2
       RETURNING *`,
      [tags, id],
    );
    return result.rows[0] || null;
  }

  /**
   * Find completed transactions for a user since a given date.
   * Used for calculating daily transaction totals within a rolling 24-hour window.
   * @param userId - The user's ID
   * @param since - The start date for the time window
   * @returns Array of completed transactions ordered by created_at DESC
   */
  async findCompletedByUserSince(
    userId: string,
    since: Date,
  ): Promise<Transaction[]> {
    const result = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 
       AND status = $3 
       AND created_at >= $2
       ORDER BY created_at DESC`,
      [userId, since],
    );
    return result.rows;
  }

  async updateNotes(id: string, notes: string): Promise<Transaction | null> {
    if (notes.length > 1000)
      throw new Error("Notes cannot exceed 1000 characters");
    const result = await pool.query(
      "UPDATE transactions SET notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
      [notes, id],
    );
    return result.rows[0] || null;
  }

  async updateAdminNotes(
    id: string,
    adminNotes: string,
  ): Promise<Transaction | null> {
    if (adminNotes.length > 1000)
      throw new Error("Admin notes cannot exceed 1000 characters");
    const result = await pool.query(
      "UPDATE transactions SET admin_notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
      [adminNotes, id],
    );
    return result.rows[0] || null;
  }

  async searchByNotes(query: string): Promise<Transaction[]> {
    const result = await pool.query(
      `SELECT * FROM transactions 
       WHERE to_tsvector('english', COALESCE(notes, '') || ' ' || COALESCE(admin_notes, '')) @@ plainto_tsquery('english', $1)
       ORDER BY created_at DESC`,
      [query],
    );
    return result.rows;
  }
}
