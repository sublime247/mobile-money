import logger from "../utils/logger";
import { Router, Request, Response } from 'express';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

/** All columns available for export — full transaction schema. */
const ALL_EXPORT_COLUMNS = [
  'id',
  'user_id',
  'amount',
  'currency',
  'type',
  'status',
  'created_at',
  'updated_at',
  'description',
  'reference',
  'fee',
  'net_amount',
  'provider',
  'channel',
  'country',
  'phone_number',
  'external_id',
  'metadata',
] as const;

type ExportColumn = (typeof ALL_EXPORT_COLUMNS)[number];

/** Default column set — matches the original CSV_HEADERS for backwards compat. */
const DEFAULT_EXPORT_COLUMNS: ExportColumn[] = [
  'id',
  'user_id',
  'amount',
  'currency',
  'type',
  'status',
  'created_at',
  'description',
];

// Keep backwards-compatible alias used by transactionRowToCsv
const CSV_HEADERS = DEFAULT_EXPORT_COLUMNS;

/**
 * Parse the ?columns= query parameter into a validated column list.
 *
 * Accepts a comma-separated string of column names.
 * Any unknown column names are silently dropped.
 * Falls back to DEFAULT_EXPORT_COLUMNS when the param is absent or empty.
 *
 * @example
 *   ?columns=id,amount,currency,status
 */
function parseColumnSelection(raw: string | undefined): ExportColumn[] {
  if (!raw || !raw.trim()) return DEFAULT_EXPORT_COLUMNS;

  const requested = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  const valid = requested.filter((c): c is ExportColumn =>
    (ALL_EXPORT_COLUMNS as readonly string[]).includes(c),
  );

  return valid.length > 0 ? valid : DEFAULT_EXPORT_COLUMNS;
}

function parseTransactionExportFilters(query: any) {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    status: query.status,
    type: query.type,
    userId: query.userId,
  };
}

function getScopedUserId(req: Request): string | null {
  // Extract user ID from authenticated request
  return (req as any).user?.id || null;
}

function buildTransactionExportQuery(filters: any) {
  const conditions = [];
  const values = [];
  let paramCount = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramCount++}`);
    values.push(filters.userId);
  }

  if (filters.startDate) {
    conditions.push(`created_at >= $${paramCount++}`);
    values.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push(`created_at <= $${paramCount++}`);
    values.push(filters.endDate);
  }

  if (filters.status) {
    conditions.push(`status = $${paramCount++}`);
    values.push(filters.status);
  }

  if (filters.type) {
    conditions.push(`type = $${paramCount++}`);
    values.push(filters.type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const text = `SELECT * FROM transactions ${whereClause} ORDER BY created_at DESC`;

  return { text, values };
}

function transactionRowToCsv(row: Record<string, unknown>): string {
  const values = CSV_HEADERS.map(header => {
    const value = row[header];
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    // Escape commas and quotes
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  });
  return values.join(',') + '\n';
}

export function createExportRoutes(options?: {
  db?: any;
  createQueryStream?: any;
}) {
  const db = options?.db || require("../config/database").pool;
  const createQueryStream = options?.createQueryStream || require("pg-query-stream");

  const router = Router();

  router.get("/export", async (req: Request, res: Response) => {
    let client: any;
    let clientReleased = false;
    let releaseClient = () => {
      if (!clientReleased && client) {
        client.release();
        clientReleased = true;
      }
    };

    try {
      // Parse requested columns — defaults to DEFAULT_EXPORT_COLUMNS
      const selectedColumns = parseColumnSelection(req.query.columns as string | undefined);

      const filters = parseTransactionExportFilters(req.query);
      const scopedUserId = getScopedUserId(req);

      if (scopedUserId) {
        filters.userId = scopedUserId;
      }

      const { text, values } = buildTransactionExportQuery(filters);

      client = await db.connect();
      releaseClient = () => client.release();
      const queryStream = createQueryStream(text, values);
      const rowStream = client.query(queryStream);

      const format = req.query.format === "json" ? "json" : "csv";
      const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${format}`;

      res.status(200);
      res.setHeader(
        "Content-Type",
        format === "json" ? "application/json" : "text/csv; charset=utf-8",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      let transform: Transform;

      if (format === "csv") {
        res.write(selectedColumns.join(",") + "\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            // Render only the user-selected columns, with RFC 4180 CSV escaping
            const vals = selectedColumns.map((col) => {
              const v = chunk[col];
              if (v === null || v === undefined) return "";
              const s = typeof v === "object" ? JSON.stringify(v) : String(v);
              return s.includes(",") || s.includes('"') || s.includes("
")
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            });
            callback(null, vals.join(",") + "
");
          },
        });
      } else {
        let first = true;
        res.write("[\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            const data =
              (first ? "" : ",\n") + JSON.stringify(chunk, null, 2);
            first = false;
            callback(null, data);
          },
          flush(callback) {
            res.write("\n]");
            callback();
          },
        });
      }

      res.on("close", () => {
        if ("destroy" in rowStream && typeof rowStream.destroy === "function") {
          rowStream.destroy();
        }
        releaseClient();
      });

      await pipeline(rowStream, transform, res);
    } catch (error) {
      logger.error("Transaction export failed:", error);
      releaseClient();
      if (!res.headersSent) {
        res.status(500).json({ error: "Export failed" });
      }
    }
  });

  return router;
}