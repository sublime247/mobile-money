import { pool } from "../config/database";

export interface AuditLog {
  id: string;
  adminId: string;
  action: string;
  resource: string;
  resourceId: string | null;
  diff: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  payloadHash: string;
  previousEntryHash: string | null;
  createdAt: Date;
}

export interface CreateAuditLogInput {
  adminId: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  diff: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  payloadHash: string;
  previousEntryHash?: string | null;
}

export interface AuditLogFilter {
  adminId?: string;
  action?: string;
  resource?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
}

const selectFields = `
  id,
  admin_id AS "adminId",
  action,
  resource,
  resource_id AS "resourceId",
  diff,
  ip_address AS "ipAddress",
  user_agent AS "userAgent",
  payload_hash AS "payloadHash",
  previous_entry_hash AS "previousEntryHash",
  created_at AS "createdAt"
`;

const buildFilterQuery = (filter: AuditLogFilter) => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const [column, value] of [
    ["admin_id", filter.adminId],
    ["action", filter.action],
    ["resource", filter.resource],
    ["resource_id", filter.resourceId],
  ] as const) {
    if (value) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
};

export class AuditLogModel {
  async create(input: CreateAuditLogInput): Promise<AuditLog> {
    const result = await pool.query<AuditLog>(
      `
        INSERT INTO audit_logs (
          admin_id,
          action,
          resource,
          resource_id,
          diff,
          ip_address,
          user_agent,
          payload_hash,
          previous_entry_hash
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING ${selectFields}
      `,
      [
        input.adminId,
        input.action,
        input.resource,
        input.resourceId ?? null,
        JSON.stringify(input.diff),
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.payloadHash,
        input.previousEntryHash ?? null,
      ],
    );

    return result.rows[0];
  }

  async findById(id: string): Promise<AuditLog | null> {
    const result = await pool.query<AuditLog>(
      `
        SELECT ${selectFields}
        FROM audit_logs
        WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ?? null;
  }

  async list(filter: AuditLogFilter = {}): Promise<AuditLog[]> {
    const { whereClause, params } = buildFilterQuery(filter);

    params.push(filter.limit ?? 100);
    const limitParameter = params.length;
    params.push(filter.offset ?? 0);
    const offsetParameter = params.length;

    const result = await pool.query<AuditLog>(
      `
        SELECT ${selectFields}
        FROM audit_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitParameter} OFFSET $${offsetParameter}
      `,
      params,
    );

    return result.rows;
  }

  async count(filter: AuditLogFilter = {}): Promise<number> {
    const { whereClause, params } = buildFilterQuery(filter);
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs ${whereClause}`,
      params,
    );

    return Number(result.rows[0]?.count ?? 0);
  }
}
