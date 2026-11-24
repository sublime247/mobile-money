import logger from "../utils/logger";
import {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import { Transform, Writable } from "stream";
import { finished, pipeline } from "stream/promises";
import archiver from "archiver";
import PDFDocument from "pdfkit";
import { requireAuth, AuthRequest } from "../middleware/auth";
import {
  DEFAULT_ALLOWED_HEADERS,
  EXTENDED_ALLOWED_HEADERS,
  parseTransactionExportFilters as parseFiltersUtil,
  buildTransactionExportQuery as buildQueryUtil,
  transactionRowToCsv as rowToCsvUtil,
  TransactionExportFilters,
  RawExportQuery,
} from "../utils/csvExporter";
import rateLimit from "express-rate-limit";
import { createReportSigningTransform } from "../security/reportSigner";

export const ALLOWED_HEADERS = [
  ...DEFAULT_ALLOWED_HEADERS,
  ...EXTENDED_ALLOWED_HEADERS.filter(
    (h) => !DEFAULT_ALLOWED_HEADERS.includes(h),
  ),
];

export const ADMIN_DISPLAY_HEADERS = [
  "ID",
  "Reference Number",
  "Type",
  "Amount",
  "Phone Number",
  "Provider",
  "Status",
  "Stellar Address",
  "Tags",
  "Notes",
  "Admin Notes",
  "User ID",
  "Created At",
  "Updated At",
];

const PDF_COLUMN_LABELS: Record<string, string> = {
  id: "ID",
  user_id: "User",
  amount: "Amount",
  currency: "Currency",
  type: "Type",
  status: "Status",
  created_at: "Date",
  description: "Description",
};

export function parseTransactionExportFilters(
  query: RawExportQuery,
): TransactionExportFilters {
  return parseFiltersUtil(query);
}

export function buildTransactionExportQuery(
  filters: TransactionExportFilters,
  exportHeaders?: string[],
) {
  return buildQueryUtil(filters, exportHeaders);
}

export function transactionRowToCsv(
  row: Record<string, unknown>,
  headers: string[],
): string {
  return rowToCsvUtil(row, headers);
}

export const exportRateLimiter =
  process.env.NODE_ENV === "test"
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many export requests, please try again later." },
      });

export interface ExportRouteOptions {
  db?: {
    connect: () => Promise<{
      query: (q: unknown) => unknown;
      release: () => void;
    }>;
  };
  createQueryStream?: (text: string, values: unknown[]) => unknown;
  rateLimiter?: RequestHandler;
}

/** Render a transaction row stream as a paginated PDF table, piped directly to `res`. */
async function streamPdfExport(
  rowStream: AsyncIterable<Record<string, unknown>>,
  headers: string[],
  output: Writable,
): Promise<void> {
  const doc = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
  doc.pipe(output);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 40;
  const tableWidth = pageWidth - margin * 2;
  const colWidth = tableWidth / headers.length;

  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .text("Transaction Export", { align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text(`Generated: ${new Date().toISOString()}`, { align: "center" });
  doc.moveDown(0.8);

  const drawHeaderRow = () => {
    const y = doc.y;
    doc
      .rect(margin, y, tableWidth, 18)
      .fillColor("#f0f0f0")
      .fill()
      .fillColor("#000000")
      .font("Helvetica-Bold")
      .fontSize(8);
    headers.forEach((header, i) => {
      doc.text(
        PDF_COLUMN_LABELS[header] ?? header,
        margin + i * colWidth + 2,
        y + 5,
        {
          width: colWidth - 4,
        },
      );
    });
    doc.y = y + 18;
    doc.font("Helvetica").fontSize(8).fillColor("#000000");
  };

  drawHeaderRow();

  let rowCount = 0;
  for await (const row of rowStream) {
    if (doc.y > pageHeight - 60) {
      doc.addPage();
      doc.moveDown(0.5);
      drawHeaderRow();
    }

    const y = doc.y;
    headers.forEach((header, i) => {
      const value = row[header];
      const text = value === null || value === undefined ? "" : String(value);
      doc.text(text, margin + i * colWidth + 2, y + 4, {
        width: colWidth - 4,
      });
    });
    doc.y = y + 16;
    rowCount++;
  }

  if (rowCount === 0) {
    doc.moveDown(0.5).fillColor("#999").text("No transactions found.");
  }

  doc.end();
  await finished(doc);
}

async function streamSignedExport(
  rowStream: AsyncIterable<Record<string, unknown>>,
  headers: string[],
  format: "csv" | "pdf",
  filename: string,
  res: Response,
): Promise<void> {
  const privateKey = process.env.ANCHOR_REPORT_SIGNING_KEY;
  if (!privateKey)
    throw new Error("ANCHOR_REPORT_SIGNING_KEY is not configured");

  const reportFilename = filename.replace(/\.zip$/, `.${format}`);
  const { stream, finalize } = createReportSigningTransform(privateKey);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (error) => stream.destroy(error));
  archive.pipe(res);
  archive.append(stream, { name: reportFilename });

  if (format === "pdf") {
    await streamPdfExport(rowStream, headers, stream);
    await finished(stream);
  } else {
    let first = true;
    const csvTransform = new Transform({
      objectMode: true,
      transform(chunk: Record<string, unknown>, _encoding, callback) {
        const data =
          (first ? "\uFEFF" : "") +
          (first ? `${headers.join(",")}\n` : "") +
          transactionRowToCsv(chunk, headers);
        first = false;
        callback(null, data);
      },
      flush(callback) {
        if (first) callback(null, `\uFEFF${headers.join(",")}\n`);
        else callback();
      },
    });
    await pipeline(rowStream as NodeJS.ReadableStream, csvTransform, stream);
  }

  const metadata = finalize();
  archive.append(metadata.signature, { name: `${reportFilename}.sig` });
  archive.append(JSON.stringify(metadata, null, 2), {
    name: `${reportFilename}.metadata.json`,
  });
  await new Promise<void>((resolve, reject) => {
    archive.once("error", reject);
    res.once("finish", resolve);
    archive.finalize();
  });
}

export function createExportRoutes(options?: ExportRouteOptions) {
  const db = options?.db || require("../config/database").pool;
  const createQueryStream =
    options?.createQueryStream || require("pg-query-stream");

  const router = Router();
  const limiter = options?.rateLimiter || exportRateLimiter;

  router.get(
    "/export",
    requireAuth,
    limiter,
    async (req: AuthRequest, res: Response) => {
      let client: any;
      let clientReleased = false;
      let releaseClient = () => {
        if (!clientReleased && client) {
          client.release();
          clientReleased = true;
        }
      };

      try {
        if (!req.user?.id) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const filters = parseTransactionExportFilters(
          req.query as RawExportQuery,
        );
        // Always scope to the authenticated caller — never trust a
        // client-supplied userId, otherwise any user could export another
        // user's transactions by guessing their ID.
        filters.userId = req.user.id;

        const requestedFields = filters.fields?.filter((f: string) =>
          ALLOWED_HEADERS.includes(f.toLowerCase()),
        );
        const exportHeaders =
          requestedFields && requestedFields.length > 0
            ? requestedFields
            : DEFAULT_ALLOWED_HEADERS;

        const { text, values } = buildTransactionExportQuery(
          filters,
          exportHeaders,
        );

        client = await db.connect();
        releaseClient = () => client.release();
        const queryStream = createQueryStream(text, values);
        const rowStream = client.query(queryStream);

        const format = ["json", "pdf"].includes(req.query.format as string)
          ? (req.query.format as "json" | "pdf")
          : "csv";
        const signed = req.query.signed === "true";
        const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${signed ? "zip" : format}`;

        res.status(200);
        res.setHeader(
          "Content-Type",
          signed
            ? "application/zip"
            : format === "json"
              ? "application/json"
              : format === "pdf"
                ? "application/pdf"
                : "text/csv; charset=utf-8",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );

        res.on("close", () => {
          if (
            "destroy" in rowStream &&
            typeof rowStream.destroy === "function"
          ) {
            rowStream.destroy();
          }
          releaseClient();
        });

        if (signed) {
          if (format === "json") {
            throw new Error("Signed exports support CSV and PDF formats only");
          }
          await streamSignedExport(
            rowStream,
            exportHeaders,
            format,
            filename,
            res,
          );
          releaseClient();
          return;
        }

        if (format === "pdf") {
          await streamPdfExport(rowStream, exportHeaders, res);
          releaseClient();
          return;
        }

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

        await pipeline(rowStream, transform, res);
      } catch (error) {
        logger.error("Transaction export failed:", error);
        releaseClient();
        if (!res.headersSent) {
          res.status(500).json({ error: "Export failed" });
        }
      }
    },
  );

  return router;
}
