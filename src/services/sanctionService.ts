import { pool } from "../config/database";
import axios from "axios";

export interface SanctionEntity {
  name: string;
  country?: string;
  source: string;
  category?: string;
  external_id?: string;
}

export class SanctionScreeningError extends Error {
  constructor(
    public readonly party: "sender" | "receiver",
    public readonly screenedName: string,
    public readonly matchedEntity: string,
    public readonly score: number,
    public readonly source: string,
  ) {
    super(
      `Sanction screening blocked: ${party} "${screenedName}" matched "${matchedEntity}" (score ${score.toFixed(2)}) on ${source}`,
    );
    this.name = "SanctionScreeningError";
  }
}

export class SanctionService {
  /**
   * Fetches the latest sanction list updates from a public source.
   * For this implementation, we mock the fetch with a set of sample data.
   */
  async fetchSanctionUpdates(): Promise<SanctionEntity[]> {
    // In a production environment, this would call external APIs like UN or OFAC.
    // Example: const response = await axios.get("https://scsanctions.un.org/resources/xml/en/consolidated.xml");

    // Mocked data for demonstration
    return [
      {
        name: "John Doe",
        country: "Country A",
        source: "UN",
        category: "Individual",
        external_id: "UN-123",
      },
      {
        name: "Global Arms Ltd",
        country: "Country B",
        source: "OFAC",
        category: "Entity",
        external_id: "OFAC-456",
      },
      {
        name: "Jane Smith",
        country: "Country C",
        source: "EU",
        category: "Individual",
        external_id: "EU-789",
      },
      {
        name: "Osama bin Laden",
        country: "Saudi Arabia",
        source: "UN",
        category: "Individual",
        external_id: "UN-001",
      },
    ];
  }

  /**
   * Batch updates the internal sanction list in the database.
   */
  async updateSanctionList(entities: SanctionEntity[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const entity of entities) {
        const query = `
          INSERT INTO sanction_list (name, country, source, category, external_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (external_id, source) DO UPDATE SET
            name = EXCLUDED.name,
            country = EXCLUDED.country,
            category = EXCLUDED.category,
            updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(query, [
          entity.name,
          entity.country ?? null,
          entity.source,
          entity.category ?? null,
          entity.external_id ?? null,
        ]);
      }

      await client.query("COMMIT");
      console.log(`Successfully synced ${entities.length} sanction entities.`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Failed to update sanction list:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Searches for a name in the sanction list using fuzzy matching.
   * Returns a list of potential matches with their scores.
   */
  async searchSanctions(
    name: string,
    threshold: number = 0.85,
  ): Promise<{ entity: SanctionEntity; score: number }[]> {
    const query =
      "SELECT name, country, source, category, external_id FROM sanction_list";
    const { rows } = await pool.query(query);

    const matches: { entity: SanctionEntity; score: number }[] = [];
    const normalizedTarget = name.toLowerCase().trim();

    for (const row of rows) {
      const normalizedSource = row.name.toLowerCase().trim();
      const score = this.jaroWinkler(normalizedTarget, normalizedSource);

      if (score >= threshold) {
        matches.push({
          entity: {
            name: row.name,
            country: row.country,
            source: row.source,
            category: row.category,
            external_id: row.external_id,
          },
          score,
        });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Jaro-Winkler distance algorithm for fuzzy string matching.
   */
  private jaroWinkler(s1: string, s2: string): number {
    if (s1 === s2) return 1.0;

    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0.0;

    const maxDist = Math.floor(Math.max(len1, len2) / 2) - 1;

    const match1 = new Array(len1).fill(false);
    const match2 = new Array(len2).fill(false);

    let matches = 0;
    for (let i = 0; i < len1; i++) {
      const start = Math.max(0, i - maxDist);
      const end = Math.min(i + maxDist + 1, len2);
      for (let j = start; j < end; j++) {
        if (match2[j]) continue;
        if (s1[i] !== s2[j]) continue;
        match1[i] = true;
        match2[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (!match1[i]) continue;
      while (!match2[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    const jaro =
      (matches / len1 +
        matches / len2 +
        (matches - transpositions / 2) / matches) /
      3;

    let prefix = 0;
    for (let i = 0; i < Math.min(4, len1, len2); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * Screens both sender and receiver against the sanction list.
   * Throws SanctionScreeningError immediately on the first hit.
   */
  async checkParties(senderName: string, receiverName: string): Promise<void> {
    const parties: Array<{ name: string; role: "sender" | "receiver" }> = [
      { name: senderName, role: "sender" },
      { name: receiverName, role: "receiver" },
    ];

    for (const { name, role } of parties) {
      const matches = await this.searchSanctions(name);
      if (matches.length > 0) {
        const top = matches[0];
        throw new SanctionScreeningError(
          role,
          name,
          top.entity.name,
          top.score,
          top.entity.source,
        );
      }
    }
  }
}

export const sanctionService = new SanctionService();
