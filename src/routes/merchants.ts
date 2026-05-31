import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "../middleware/auth";
import multer, { MulterError } from "multer";
import csvParser from "csv-parser";
import { Readable } from "stream";
import { MerchantModel } from "../models/merchant";

interface CsvRow {
  email?: string;
  name?: string;
  business_type?: string;
  [key: string]: string | undefined;
}

interface FailedRow {
  row: number;
  error: string;
}

interface SuccessfulRow {
  row: number;
  email: string;
  name: string;
  business_type: string;
}

function parseCsv(buffer: Buffer): Promise<CsvRow[]> {
  return new Promise((resolve, reject) => {
    const rows: CsvRow[] = [];
    Readable.from(buffer.toString("utf-8"))
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => {
            const h = header.trim().toLowerCase();
            if (
              h === "businesstype" ||
              h === "business_type" ||
              h === "business type"
            ) {
              return "business_type";
            }
            return h;
          },
          mapValues: ({ value }) => value.trim(),
        }),
      )
      .on("data", (row: CsvRow) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.toLowerCase().endsWith(".csv");

    if (isCsv) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

export const merchantRoutes = Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

merchantRoutes.post(
  "/bulk",
  authenticateToken,
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
        message:
          'Send a CSV file using multipart/form-data with field name "file"',
      });
    }

    let rows: CsvRow[];
    try {
      rows = await parseCsv(req.file.buffer);
    } catch (err) {
      return res.status(400).json({
        error: "Failed to parse CSV",
        message: err instanceof Error ? err.message : "Unknown parse error",
      });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: "CSV file contains no data rows" });
    }

    const failed_rows: FailedRow[] = [];
    const schemaValidRows: Array<{
      row: number;
      email: string;
      name: string;
      business_type: string;
    }> = [];
    const seenEmails = new Set<string>();

    // Pass 1: Schema Validation & within-file duplicate check
    rows.forEach((row, index) => {
      const rowNum = index + 2; // header is row 1, data starts at 2
      const email = row.email;
      const name = row.name;
      const businessType = row.business_type;

      if (!email || !emailRegex.test(email)) {
        failed_rows.push({
          row: rowNum,
          error: `Invalid or missing email: ${email || ""}`,
        });
        return;
      }

      if (!name || name.trim() === "") {
        failed_rows.push({
          row: rowNum,
          error: "Missing merchant name",
        });
        return;
      }

      if (!businessType || businessType.trim() === "") {
        failed_rows.push({
          row: rowNum,
          error: "Missing business type",
        });
        return;
      }

      const lowerEmail = email.toLowerCase();
      if (seenEmails.has(lowerEmail)) {
        failed_rows.push({
          row: rowNum,
          error: `Duplicate merchant email in CSV: ${email}`,
        });
        return;
      }

      seenEmails.add(lowerEmail);
      schemaValidRows.push({
        row: rowNum,
        email: lowerEmail,
        name: name,
        business_type: businessType,
      });
    });

    // Pass 2: Conflict/Existence check in Database
    const merchantModel = new MerchantModel();
    const finalValidRows: Array<{
      row: number;
      email: string;
      name: string;
      business_type: string;
    }> = [];

    if (schemaValidRows.length > 0) {
      const emailsToCheck = schemaValidRows.map((r) => r.email);
      try {
        const existingEmails =
          await merchantModel.checkExistingEmails(emailsToCheck);

        schemaValidRows.forEach((row) => {
          if (existingEmails.has(row.email)) {
            failed_rows.push({
              row: row.row,
              error: `Duplicate merchant email in database: ${row.email}`,
            });
          } else {
            finalValidRows.push(row);
          }
        });
      } catch (err) {
        return res.status(500).json({
          error: "Database lookup failed during conflict check",
          message:
            err instanceof Error ? err.message : "Unknown database error",
        });
      }
    }

    // Phase 2: Transactional Batch-Insert for finalValidRows
    if (finalValidRows.length > 0) {
      try {
        await merchantModel.batchInsert(finalValidRows);
      } catch (err) {
        return res.status(500).json({
          error: "Bulk insertion failed",
          message:
            err instanceof Error ? err.message : "Unknown database error",
        });
      }
    }

    // Phase 3: Feedback Loop - Separating successful from failed rows
    const successful_rows: SuccessfulRow[] = finalValidRows.map((r) => ({
      row: r.row,
      email: r.email,
      name: r.name,
      business_type: r.business_type,
    }));

    // Sort responses by row number for UI consistency
    successful_rows.sort((a, b) => a.row - b.row);
    failed_rows.sort((a, b) => a.row - b.row);

    return res.status(200).json({
      successful_rows,
      failed_rows,
    });
  },
);

merchantRoutes.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({ error: "File too large - maximum size is 10 MB" });
    }

    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }

    next(err);
  },
);
