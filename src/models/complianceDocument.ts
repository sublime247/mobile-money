import { pool } from "../config/database";

export type ComplianceDocumentStatus = "draft" | "published" | "archived";

export interface ComplianceDocument {
  id: string;
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  provider?: string | null;
  tags: string[];
  sourceUrl?: string | null;
  status: ComplianceDocumentStatus;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ComplianceDocumentCreateInput {
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  provider?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  status?: ComplianceDocumentStatus;
}

export interface ComplianceDocumentUpdateInput {
  title?: string;
  summary?: string | null;
  body?: string;
  countryCode?: string | null;
  provider?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  status?: ComplianceDocumentStatus;
}

export interface ComplianceDocumentFilter {
  country?: string;
  provider?: string;
  tag?: string;
  status?: ComplianceDocumentStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ComplianceDocumentListResult {
  documents: ComplianceDocument[];
  total: number;
}

export interface ComplianceDocumentFacets {
  countries: string[];
  providers: string[];
  tags: string[];
}

const selectFields = `
  id,
  title,
  summary,
  body,
  country_code AS "countryCode",
  provider,
  tags,
  source_url AS "sourceUrl",
  status,
  created_by AS "createdBy",
  updated_by AS "updatedBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/**
 * Row shape returned by selectFields queries (aliased to camelCase).
 * The mapRow fallbacks also accept raw snake_case rows from `SELECT *`.
 */
export interface ComplianceDocumentRow {
  id: string;
  title: string;
  summary?: string | null;
  body: string;
  countryCode?: string | null;
  country_code?: string | null;
  provider?: string | null;
  tags?: string[] | null;
  sourceUrl?: string | null;
  source_url?: string | null;
  status: ComplianceDocumentStatus | string;
  createdBy?: string | null;
  created_by?: string | null;
  updatedBy?: string | null;
  updated_by?: string | null;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}

export class ComplianceDocumentModel {
  async create(
    input: ComplianceDocumentCreateInput,
    actorUserId?: string,
  ): Promise<ComplianceDocument> {
    const query = `
      INSERT INTO compliance_documents (
        title, summary, body, country_code, provider, tags, source_url, status, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      RETURNING ${selectFields}
    `;

    const result = await pool.query<ComplianceDocumentRow>(query, [
      input.title,
      input.summary ?? null,
      input.body,
      input.countryCode ?? null,
      input.provider ?? null,
      input.tags ?? [],
      input.sourceUrl ?? null,
      input.status ?? "published",
      actorUserId ?? null,
    ]);

    return this.mapRow(result.rows[0]);
  }

  async list(
    filter: ComplianceDocumentFilter = {},
  ): Promise<ComplianceDocumentListResult> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    } else {
      conditions.push("status <> 'archived'");
    }

    if (
      filter.country &&
      typeof filter.country === "string" &&
      filter.country.trim()
    ) {
      conditions.push(`country_code = $${paramIndex++}`);
      params.push(filter.country.trim().toUpperCase());
    }

    if (
      filter.provider &&
      typeof filter.provider === "string" &&
      filter.provider.trim()
    ) {
      conditions.push(`LOWER(provider) = LOWER($${paramIndex++})`);
      params.push(filter.provider.trim());
    }

    if (filter.tag && typeof filter.tag === "string" && filter.tag.trim()) {
      conditions.push(`LOWER($${paramIndex++}) = ANY(tags)`);
      params.push(filter.tag.trim().toLowerCase());
    }

    if (
      filter.search &&
      typeof filter.search === "string" &&
      filter.search.trim()
    ) {
      const sanitizedSearch = filter.search.trim().replace(/([%_\\])/g, "\\$1");
      conditions.push(`(
        title ILIKE $${paramIndex} ESCAPE '\\'
        OR summary ILIKE $${paramIndex} ESCAPE '\\'
        OR body ILIKE $${paramIndex} ESCAPE '\\'
        OR provider ILIKE $${paramIndex} ESCAPE '\\'
        OR array_to_string(tags, ' ') ILIKE $${paramIndex} ESCAPE '\\'
      )`);
      params.push(`%${sanitizedSearch}%`);
      paramIndex++;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM compliance_documents ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const listResult = await pool.query<ComplianceDocumentRow>(
      `
        SELECT ${selectFields}
        FROM compliance_documents
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      [...params, limit, offset],
    );

    return {
      documents: listResult.rows.map((row) => this.mapRow(row)),
      total,
    };
  }

  async findById(id: string): Promise<ComplianceDocument | null> {
    const result = await pool.query<ComplianceDocumentRow>(
      `
        SELECT ${selectFields}
        FROM compliance_documents
        WHERE id = $1
      `,
      [id],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async update(
    id: string,
    input: ComplianceDocumentUpdateInput,
    actorUserId?: string,
  ): Promise<ComplianceDocument | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    const addField = (column: string, value: unknown) => {
      fields.push(`${column} = $${paramIndex++}`);
      params.push(value);
    };

    if (Object.prototype.hasOwnProperty.call(input, "title"))
      addField("title", input.title);
    if (Object.prototype.hasOwnProperty.call(input, "summary"))
      addField("summary", input.summary ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "body"))
      addField("body", input.body);
    if (Object.prototype.hasOwnProperty.call(input, "countryCode"))
      addField("country_code", input.countryCode ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "provider"))
      addField("provider", input.provider ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "tags"))
      addField("tags", input.tags ?? []);
    if (Object.prototype.hasOwnProperty.call(input, "sourceUrl"))
      addField("source_url", input.sourceUrl ?? null);
    if (Object.prototype.hasOwnProperty.call(input, "status"))
      addField("status", input.status);

    fields.push("updated_at = CURRENT_TIMESTAMP");
    fields.push(`updated_by = $${paramIndex++}`);
    params.push(actorUserId ?? null);
    params.push(id);

    const result = await pool.query<ComplianceDocumentRow>(
      `
        UPDATE compliance_documents
        SET ${fields.join(", ")}
        WHERE id = $${paramIndex}
        RETURNING ${selectFields}
      `,
      params,
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async archive(
    id: string,
    actorUserId?: string,
  ): Promise<ComplianceDocument | null> {
    const result = await pool.query<ComplianceDocumentRow>(
      `
        UPDATE compliance_documents
        SET status = 'archived', updated_at = CURRENT_TIMESTAMP, updated_by = $1
        WHERE id = $2
        RETURNING ${selectFields}
      `,
      [actorUserId ?? null, id],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async getFacets(): Promise<ComplianceDocumentFacets> {
    const result = await pool.query<{
      countries: string[];
      providers: string[];
      tags: string[];
    }>(`
      SELECT
        ARRAY(
          SELECT DISTINCT country_code
          FROM compliance_documents
          WHERE country_code IS NOT NULL AND status <> 'archived'
          ORDER BY country_code
        ) AS countries,
        ARRAY(
          SELECT DISTINCT provider
          FROM compliance_documents
          WHERE provider IS NOT NULL AND status <> 'archived'
          ORDER BY provider
        ) AS providers,
        ARRAY(
          SELECT DISTINCT value
          FROM compliance_documents, unnest(tags) AS tag(value)
          WHERE status <> 'archived'
          ORDER BY value
        ) AS tags
    `);

    return {
      countries: result.rows[0]?.countries ?? [],
      providers: result.rows[0]?.providers ?? [],
      tags: result.rows[0]?.tags ?? [],
    };
  }

  private mapRow(row: ComplianceDocumentRow): ComplianceDocument {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary ?? null,
      body: row.body,
      countryCode: row.countryCode ?? row.country_code ?? null,
      provider: row.provider ?? null,
      tags: row.tags ?? [],
      sourceUrl: row.sourceUrl ?? row.source_url ?? null,
      status: row.status as ComplianceDocumentStatus,
      createdBy: row.createdBy ?? row.created_by ?? null,
      updatedBy: row.updatedBy ?? row.updated_by ?? null,
      createdAt: row.createdAt ?? row.created_at ?? "",
      updatedAt: row.updatedAt ?? row.updated_at ?? "",
    };
  }
}
