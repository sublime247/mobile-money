import { Router, Request, Response } from 'express';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const CSV_HEADERS = [
  'id',
  'user_id',
  'amount',
  'currency',
  'type',
  'status',
  'created_at',
  'description'
];

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
    let client;
    let releaseClient = () => {};

    try {
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
        res.write(`${CSV_HEADERS.join(",")}\n`);
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            callback(null, transactionRowToCsv(chunk));
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

      pipeline(rowStream, transform, res, (error) => {
        releaseClient();
        if (error) {
          console.error("Transaction export pipeline failed:", error);
        }
      });
    } catch (error) {
      console.error("Transaction export failed:", error);
      releaseClient();
      if (!res.headersSent) {
        res.status(500).json({ error: "Export failed" });
      }
    }
  });

  return router;
}