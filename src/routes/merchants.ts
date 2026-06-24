import { Router, Request, Response, NextFunction } from "express";
import multer, { MulterError } from "multer";
import { Readable } from "stream";
import csvParser from "csv-parser";
import { MerchantService } from "../services/merchantService";
import { CreateMerchantInput } from "../models/merchant";
import { authenticateToken } from "../middleware/auth";
import { checkAccountStatusStrict } from "../middleware/checkAccountStatus";

interface CsvRow {
  name: string;
  email: string;
  phone_number: string;
  business_name?: string;
  business_type?: string;
  tax_id?: string;
  address?: string;
  city?: string;
  country?: string;
  [key: string]: string | undefined;
}

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?\d{7,15}$/;
const COUNTRY_REGEX = /^[A-Z]{2}$/;

function validateRow(row: CsvRow, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const rowNum = index + 2; // Row 1 is header

  // Validate name (required)
  if (!row.name || row.name.trim().length === 0) {
    errors.push({
      row: rowNum,
      field: "name",
      message: "Name is required",
    });
  } else if (row.name.length > 255) {
    errors.push({
      row: rowNum,
      field: "name",
      message: "Name must be less than 255 characters",
    });
  }

  // Validate email (required)
  if (!row.email || !EMAIL_REGEX.test(row.email.trim())) {
    errors.push({
      row: rowNum,
      field: "email",
      message: "Valid email is required",
    });
  } else if (row.email.length > 255) {
    errors.push({
      row: rowNum,
      field: "email",
      message: "Email must be less than 255 characters",
    });
  }

  // Validate phone number (required)
  if (!row.phone_number || !PHONE_REGEX.test(row.phone_number.replace(/[\s\-()]/g, ""))) {
    errors.push({
      row: rowNum,
      field: "phone_number",
      message: "Valid phone number is required (7-15 digits)",
    });
  }

  // Validate country (optional but must be valid ISO code)
  if (row.country && !COUNTRY_REGEX.test(row.country.trim().toUpperCase())) {
    errors.push({
      row: rowNum,
      field: "country",
      message: "Country must be a valid ISO 3166-1 alpha-2 code (e.g., US, CM, GB)",
    });
  }

  // Validate business type length
  if (row.business_type && row.business_type.length > 100) {
    errors.push({
      row: rowNum,
      field: "business_type",
      message: "Business type must be less than 100 characters",
    });
  }

  // Validate tax ID length
  if (row.tax_id && row.tax_id.length > 50) {
    errors.push({
      row: rowNum,
      field: "tax_id",
      message: "Tax ID must be less than 50 characters",
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
        })
      )
      .on("data", (row: CsvRow) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function mapCsvRowToInput(row: CsvRow): CreateMerchantInput {
  return {
    name: row.name,
    email: row.email,
    phoneNumber: row.phone_number,
    businessName: row.business_name,
    businessType: row.business_type,
    taxId: row.tax_id,
    address: row.address,
    city: row.city,
    country: row.country,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
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

const merchantService = new MerchantService();

export const merchantRoutes = Router();

interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    [key: string]: unknown;
  };
}

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthRequest;
  const user = authReq.user;

  if (!user || (user.role !== "admin" && user.role !== "super-admin")) {
    return res.status(403).json({ message: "Admin access required" });
  }

  next();
};

// POST /api/merchants - Create single merchant
merchantRoutes.post(
  "/",
  authenticateToken,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const input: CreateMerchantInput = req.body;

      if (!input.name || !input.email || !input.phoneNumber) {
        return res.status(400).json({
          error: "Missing required fields",
          message: "Name, email, and phone_number are required",
        });
      }

      const merchant = await merchantService.createMerchant(input);

      res.status(201).json({
        message: "Merchant invitation sent successfully",
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          status: merchant.status,
          createdAt: merchant.createdAt,
        },
      });
    } catch (error) {
      console.error("[Merchants] Error creating merchant:", error);
      res.status(400).json({
        error: "Failed to create merchant",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// POST /api/merchants/bulk - Bulk import merchants via CSV
merchantRoutes.post(
  "/bulk",
  authenticateToken,
  requireAdmin,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "No file uploaded",
          message: 'Send a CSV file using multipart/form-data with field name "file"',
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
        return res.status(400).json({
          error: "CSV file contains no data rows",
        });
      }

      // Validate all rows first
      const validationErrors: ValidationError[] = [];
      rows.forEach((row, index) => {
        validationErrors.push(...validateRow(row, index));
      });

      // If there are validation errors, return them
      if (validationErrors.length > 0) {
        return res.status(422).json({
          error: "CSV validation failed",
          totalErrors: validationErrors.length,
          validationErrors,
          message: "Please fix the validation errors and try again",
        });
      }

      // Convert CSV rows to merchant inputs
      const inputs: CreateMerchantInput[] = rows.map(mapCsvRowToInput);

      // Get admin user ID from auth context
      const authReq = req as AuthRequest;
      const createdBy = authReq.user?.id as string;

      // Submit for bulk processing
      const result = await merchantService.bulkCreateMerchants(inputs, createdBy);

      res.status(202).json(result);
    } catch (error) {
      console.error("[Merchants] Error in bulk import:", error);
      res.status(500).json({
        error: "Bulk import failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// GET /api/merchants/bulk/:jobId - Get bulk import job status
merchantRoutes.get(
  "/bulk/:jobId",
  authenticateToken,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const status = await merchantService.getBatchJobStatus(jobId);

      if (!status) {
        return res.status(404).json({
          error: "Job not found",
        });
      }

      res.json(status);
    } catch (error) {
      console.error("[Merchants] Error fetching job status:", error);
      res.status(500).json({
        error: "Failed to fetch job status",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// GET /api/merchants - List merchants
merchantRoutes.get(
  "/",
  authenticateToken,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string | undefined;
      const kycStatus = req.query.kycStatus as string | undefined;

      const result = await merchantService.listMerchants({
        page,
        limit,
        status,
        kycStatus,
      });

      res.json(result);
    } catch (error) {
      console.error("[Merchants] Error listing merchants:", error);
      res.status(500).json({
        error: "Failed to list merchants",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// GET /api/merchants/:id - Get merchant by ID
merchantRoutes.get(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const merchant = await merchantService.getMerchant(id);

      if (!merchant) {
        return res.status(404).json({
          error: "Merchant not found",
        });
      }

      res.json(merchant);
    } catch (error) {
      console.error("[Merchants] Error fetching merchant:", error);
      res.status(500).json({
        error: "Failed to fetch merchant",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// POST /api/merchants/invite/:token/accept - Accept merchant invitation
merchantRoutes.post(
  "/invite/:token/accept",
  async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const merchant = await merchantService.acceptInvitation(token);

      if (!merchant) {
        return res.status(404).json({
          error: "Invalid or expired invitation token",
        });
      }

      res.json({
        message: "Invitation accepted successfully",
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          status: merchant.status,
        },
      });
    } catch (error) {
      console.error("[Merchants] Error accepting invitation:", error);
      res.status(500).json({
        error: "Failed to accept invitation",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Error handler for multer errors
merchantRoutes.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof Error && err.message === "Only CSV files are accepted") {
      return res.status(400).json({ error: err.message });
    }

    if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({ error: "File too large - maximum size is 10 MB" });
    }

    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: "Internal server error" });
  }
);