import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

const ALLOWED_HEADERS = [
  "id",
  "user_id",
  "amount",
  "currency",
  "type",
  "status",
  "created_at",
  "description",
];

function parseTransactionExportFilters(query: any) {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    status: query.status,
    type: query.type,
    userId: query.userId,
    fields: query.fields
      ? String(query.fields)
          .split(",")
          .map((f) => f.trim())
      : undefined,
  };
}

function getScopedUserId(req: Request): string | null {
  // Extract user ID from authenticated request
  return (req as any).user?.id || null;
}

function buildTransactionExportQuery(filters: any, exportHeaders: string[]) {
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

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const selectFields = exportHeaders.join(", ");
  const text = `SELECT ${selectFields} FROM transactions ${whereClause} ORDER BY created_at DESC`;

  return { text, values };
}

function transactionRowToCsv(
  row: Record<string, unknown>,
  headers: string[],
): string {
  const values = headers.map((header) => {
    const value = row[header];
    if (value === null || value === undefined) return "";
    const stringValue = String(value);
    // Escape commas and quotes
    if (
      stringValue.includes(",") ||
      stringValue.includes('"') ||
      stringValue.includes("\n")
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  });
  return values.join(",") + "\n";
}

export function createExportRoutes(options?: {
  db?: any;
  createQueryStream?: any;
}) {
  const db = options?.db || require("../config/database").pool;
  const createQueryStream =
    options?.createQueryStream || require("pg-query-stream");

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
      const filters = parseTransactionExportFilters(req.query);
      const scopedUserId = getScopedUserId(req);

      if (scopedUserId) {
        filters.userId = scopedUserId;
      }

      const requestedFields = filters.fields?.filter((f: string) =>
        ALLOWED_HEADERS.includes(f),
      );
      const exportHeaders =
        requestedFields && requestedFields.length > 0
          ? requestedFields
          : ALLOWED_HEADERS;

      const { text, values } = buildTransactionExportQuery(
        filters,
        exportHeaders,
      );

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
        res.write(`\uFEFF${exportHeaders.join(",")}\n`);
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            callback(null, transactionRowToCsv(chunk, exportHeaders));
          },
        });
      } else {
        let first = true;
        res.write("[\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            const data = (first ? "" : ",\n") + JSON.stringify(chunk, null, 2);
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
