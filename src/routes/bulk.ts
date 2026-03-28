import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "../middleware/auth";
import multer, { MulterError } from "multer";
import csvParser from "csv-parser";
import { Readable } from "stream";

import { TransactionModel, TransactionStatus } from "../models/transaction";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { StellarService } from "../services/stellar/stellarService";
import { notifyTransactionWebhook, WebhookService } from "../services/webhook";
import { checkAccountStatusStrict } from "../middleware/checkAccountStatus";


interface CsvRow {
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
}

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface BulkJob {
  id: string;
  status: JobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
  createdAt: Date;
  completedAt?: Date;
}

const jobs = new Map<string, BulkJob>();

export function getBulkImportJob(jobId: string): BulkJob | undefined {
  return jobs.get(jobId);
}

const SUPPORTED_PROVIDERS = ["MTN", "AIRTEL", "ORANGE"];
const PHONE_REGEX = /^\+\d{7,15}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

function validateRow(row: CsvRow, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const rowNum = index + 2;

  if (!row.amount || isNaN(Number(row.amount)) || Number(row.amount) <= 0) {
    errors.push({
      row: rowNum,
      field: "amount",
      message: "Must be a positive number",
    });
  }

  if (!row.phoneNumber || !PHONE_REGEX.test(row.phoneNumber.trim())) {
    errors.push({
      row: rowNum,
      field: "phoneNumber",
      message: "Must be a valid E.164 phone number (e.g. +237670000000)",
    });
  }

  if (
    !row.provider ||
    !SUPPORTED_PROVIDERS.includes(row.provider.trim().toUpperCase())
  ) {
    errors.push({
      row: rowNum,
      field: "provider",
      message: `Must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
    });
  }

  if (
    !row.stellarAddress ||
    !STELLAR_ADDRESS_REGEX.test(row.stellarAddress.trim())
  ) {
    errors.push({
      row: rowNum,
      field: "stellarAddress",
      message:
        "Must be a valid Stellar public key (56 characters, starting with G)",
    });
  }

  return errors;
}

function parseCsv(buffer: Buffer): Promise<CsvRow[]> {
  return new Promise((resolve, reject) => {
    const rows: CsvRow[] = [];
    Readable.from(buffer.toString("utf-8"))
      .pipe(
        csvParser({
          mapHeaders: ({ header }) => header.trim(),
          mapValues: ({ value }) => value.trim(),
        }),
      )
      .on("data", (row: CsvRow) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function processJob(jobId: string, rows: CsvRow[]): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  job.status = "processing";

  try {
    const transactionModel = new TransactionModel();
    const mobileMoneyService = new MobileMoneyService();
    const webhookService = new WebhookService();

    let stellarService: StellarService | null = null;
    try {
      stellarService = new StellarService();
    } catch {
      console.warn(
        "[BulkImport] StellarService unavailable - deposits will be skipped",
      );
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let transactionId: string | null = null;
      let failedAlreadyHandled = false;

      try {
        const transaction = await transactionModel.create({
          type: "deposit",
          amount: row.amount,
          phoneNumber: row.phoneNumber,
          provider: row.provider.toUpperCase(),
          stellarAddress: row.stellarAddress,
          status: TransactionStatus.Pending,
          tags: [],
        });
        transactionId = transaction.id;

        await mobileMoneyService.initiatePayment(
          row.provider,
          row.phoneNumber,
          row.amount,
        );

        if (!stellarService) {
          await transactionModel.updateStatus(
            transaction.id,
            TransactionStatus.Failed,
          );
          await notifyTransactionWebhook(transaction.id, "transaction.failed", {
            transactionModel,
            webhookService,
          });
          failedAlreadyHandled = true;
          throw new Error("StellarService unavailable - deposit not completed");
        }

        await stellarService.sendPayment(row.stellarAddress, row.amount);
        await transactionModel.updateStatus(
          transaction.id,
          TransactionStatus.Completed,
        );
        await notifyTransactionWebhook(
          transaction.id,
          "transaction.completed",
          {
            transactionModel,
            webhookService,
          },
        );

        job.succeeded++;
      } catch (error) {
        if (transactionId && !failedAlreadyHandled) {
          await transactionModel.updateStatus(
            transactionId,
            TransactionStatus.Failed,
          );
          await notifyTransactionWebhook(transactionId, "transaction.failed", {
            transactionModel,
            webhookService,
          });
        }

        job.failed++;
        job.errors.push({
          row: i + 2,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        job.processed++;
      }
    }
  } catch (error) {
    console.error("[BulkImport] Fatal error in processJob:", error);
  } finally {
    job.status = "completed";
    job.completedAt = new Date();
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

export const bulkRoutes = Router();

bulkRoutes.post(
  "/",
  authenticateToken,
  checkAccountStatusStrict,
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

    const validationErrors: ValidationError[] = [];
    rows.forEach((row, index) => {
      validationErrors.push(...validateRow(row, index));
    });

    if (validationErrors.length > 0) {
      return res.status(422).json({
        error: "CSV validation failed - no transactions were processed",
        totalErrors: validationErrors.length,
        validationErrors,
      });
    }

    const jobId = crypto.randomUUID();
    const job: BulkJob = {
      id: jobId,
      status: "pending",
      total: rows.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
      createdAt: new Date(),
    };
    jobs.set(jobId, job);

    setImmediate(() => processJob(jobId, rows));

    return res.status(202).json({
      jobId,
      message: `Bulk import queued - ${rows.length} transaction(s) will be processed`,
      statusUrl: `/api/transactions/bulk/${jobId}`,
    });
  },
);

bulkRoutes.use(
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

bulkRoutes.get("/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({
    jobId: job.id,
    status: job.status,
    progress: {
      total: job.total,
      processed: job.processed,
      succeeded: job.succeeded,
      failed: job.failed,
    },
    errors: job.errors,
    createdAt: job.createdAt,
    ...(job.completedAt && { completedAt: job.completedAt }),
  });
});
