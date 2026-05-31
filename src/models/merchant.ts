import { pool, queryRead } from "../config/database";

export interface Merchant {
  id: string;
  email: string;
  name: string;
  business_type: string;
  created_at: Date;
  updated_at: Date;
}

export class MerchantModel {
  /**
   * Checks database for existing merchant emails.
   * Returns a set of lowercase emails that already exist in the database.
   */
  async checkExistingEmails(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) {
      return new Set();
    }

    const lowercaseEmails = emails.map((e) => e.toLowerCase());

    const query =
      "SELECT email FROM merchants WHERE LOWER(email) = ANY($1::varchar[])";
    const result = await queryRead(query, [lowercaseEmails]);

    return new Set(result.rows.map((row) => row.email.toLowerCase()));
  }

  /**
   * Bulk inserts merchants inside a database transaction to ensure atomicity.
   */
  async batchInsert(
    merchants: Array<{ email: string; name: string; business_type: string }>,
  ): Promise<void> {
    if (merchants.length === 0) {
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const queryValues: any[] = [];
      const valuePlaceholders: string[] = [];

      merchants.forEach((merchant, idx) => {
        const baseIndex = idx * 3;
        valuePlaceholders.push(
          `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`,
        );
        queryValues.push(
          merchant.email.toLowerCase(),
          merchant.name.trim(),
          merchant.business_type.trim(),
        );
      });

      const insertQuery = `
        INSERT INTO merchants (email, name, business_type)
        VALUES ${valuePlaceholders.join(", ")}
      `;

      await client.query(insertQuery, queryValues);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
