import axios, { AxiosInstance } from "axios";
import { Pool } from "pg";
import { z } from "zod";

// KYC Provider: Entrust Identity Verification (formerly Onfido)
// Documentation: https://documentation.identity.entrust.com/api/latest/

// Types for KYC integration
export enum KYCLevel {
  NONE = "none",
  BASIC = "basic",
  FULL = "full",
}

export enum KYCStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
  REVIEW = "review",
}

export enum DocumentType {
  PASSPORT = "passport",
  DRIVING_LICENSE = "driving_license",
  NATIONAL_IDENTITY_CARD = "national_identity_card",
  RESIDENCE_PERMIT = "residence_permit",
}

export interface KYCApplicant {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  dob?: string;
  phone_number?: string;
  address?: {
    flat_number?: string;
    building_number?: string;
    building_name?: string;
    street: string;
    sub_street?: string;
    town: string;
    state?: string;
    postcode: string;
    country: string;
    line1?: string;
    line2?: string;
    line3?: string;
  };
  created_at: string;
  sandbox: boolean;
}

export interface KYCCheck {
  id: string;
  applicant_id: string;
  result: string;
  status: string;
  created_at: string;
  href: string;
}

export interface KYCReport {
  id: string;
  check_id: string;
  name: string;
  status: KYCStatus;
  result: string;
  breakdown?: KYCBreakdown[];
  created_at: string;
  href: string;
}

export interface KYCBreakdown {
  result: string;
  name: string;
  properties?: Record<string, any>;
}

export interface WorkflowRun {
  id: string;
  applicant_id: string;
  workflow_id: string;
  status: string;
  created_at: string;
  completed_at?: string;
  href: string;
}

export interface WebhookEvent {
  payload: {
    action: string;
    object: {
      id: string;
      type: string;
      completed_at?: string;
      status: string;
    };
    webhook_id: string;
  };
}

// Zod schemas for validation
const CreateApplicantSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email().optional(),
  dob: z.string().optional(),
  phone_number: z.string().optional(),
  address: z
    .object({
      flat_number: z.string().optional(),
      building_number: z.string().optional(),
      building_name: z.string().optional(),
      street: z.string(),
      sub_street: z.string().optional(),
      town: z.string(),
      state: z.string().optional(),
      postcode: z.string(),
      country: z.string().length(3),
      line1: z.string().optional(),
      line2: z.string().optional(),
      line3: z.string().optional(),
    })
    .optional(),
});

const UploadDocumentSchema = z.object({
  applicant_id: z.string(),
  type: z.nativeEnum(DocumentType),
  side: z.enum(["front", "back"]).optional(),
  filename: z.string(),
  data: z.string(), // Base64 encoded file data
});

export class KYCService {
  private api: AxiosInstance;
  private db: Pool;
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(db: Pool) {
    this.db = db;
    this.baseURL = process.env.KYC_API_URL || "https://api.eu.onfido.com/v3.6";
    this.apiKey =
      process.env.KYC_API_KEY ||
      (process.env.NODE_ENV === "test" ? "test_key" : "");

    if (!this.apiKey) {
      throw new Error("KYC_API_KEY environment variable is required");
    }

    this.api = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Token token=${this.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    // Add request/response interceptors for logging
    this.api.interceptors.request.use((config) => {
      console.log(
        `KYC API Request: ${config.method?.toUpperCase()} ${config.url}`,
      );
      return config;
    });

    this.api.interceptors.response.use(
      (response) => {
        console.log(
          `KYC API Response: ${response.status} ${response.config.url}`,
        );
        return response;
      },
      (error) => {
        console.error(
          `KYC API Error: ${error.response?.status} ${error.config?.url}`,
          error.response?.data,
        );
        return Promise.reject(error);
      },
    );
  }

  /**
   * Create a new KYC applicant
   */
  async createApplicant(
    applicantData: z.infer<typeof CreateApplicantSchema>,
  ): Promise<KYCApplicant> {
    try {
      const validatedData = CreateApplicantSchema.parse(applicantData);

      const response = await this.api.post("/applicants", validatedData);
      const applicant = response.data as KYCApplicant;

      // Store applicant reference in database
      await this.storeApplicantReference(applicant);

      return applicant;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid applicant data: ${error.message}`);
      }
      throw new Error(
        `Failed to create KYC applicant: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Retrieve an existing applicant
   */
  async getApplicant(applicantId: string): Promise<KYCApplicant> {
    try {
      const response = await this.api.get(`/applicants/${applicantId}`);
      return response.data as KYCApplicant;
    } catch (error) {
      throw new Error(
        `Failed to retrieve applicant: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Upload a document for verification
   */
  async uploadDocument(
    documentData: z.infer<typeof UploadDocumentSchema>,
  ): Promise<any> {
    try {
      const validatedData = UploadDocumentSchema.parse(documentData);

      // For now, we'll create a simple document upload request
      // In a real implementation, you'd need to handle multipart/form-data uploads
      const documentPayload = {
        applicant_id: validatedData.applicant_id,
        type: validatedData.type,
        side: validatedData.side,
        filename: validatedData.filename,
        // Note: In production, you'd upload the actual file data
        // For now, we'll just send the metadata
      };

      const response = await this.api.post("/documents", documentPayload);
      return response.data;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid document data: ${error.message}`);
      }
      throw new Error(
        `Failed to upload document: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Create a workflow run for comprehensive verification
   */
  async createWorkflowRun(
    applicantId: string,
    workflowId?: string,
  ): Promise<WorkflowRun> {
    try {
      const workflowData = {
        applicant_id: applicantId,
        workflow_id: workflowId || process.env.KYC_DEFAULT_WORKFLOW_ID,
      };

      const response = await this.api.post("/workflow_runs", workflowData);
      return response.data as WorkflowRun;
    } catch (error) {
      throw new Error(
        `Failed to create workflow run: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Generate SDK token for client-side SDK integration
   */
  async generateSDKToken(
    applicantId: string,
    applicationId: string,
  ): Promise<string> {
    try {
      const response = await this.api.post("/sdk_token", {
        applicant_id: applicantId,
        application_id: applicationId,
      });

      return response.data.token;
    } catch (error) {
      throw new Error(
        `Failed to generate SDK token: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get verification status for an applicant
   */
  async getVerificationStatus(applicantId: string): Promise<{
    status: KYCStatus;
    level: KYCLevel;
    checks: KYCCheck[];
    reports: KYCReport[];
  }> {
    try {
      // Get all checks for the applicant
      const checksResponse = await this.api.get(
        `/checks?applicant_id=${applicantId}`,
      );
      const checks = checksResponse.data.checks as KYCCheck[];

      // Get all reports for the applicant
      const reportsResponse = await this.api.get(
        `/reports?applicant_id=${applicantId}`,
      );
      const reports = reportsResponse.data.reports as KYCReport[];

      // Determine overall status and KYC level
      const status = this.determineOverallStatus(checks, reports);
      const level = this.determineKYCLevel(checks, reports);

      return {
        status,
        level,
        checks,
        reports,
      };
    } catch (error) {
      throw new Error(
        `Failed to get verification status: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Handle webhook events from KYC provider
   */
  async handleWebhook(event: WebhookEvent): Promise<void> {
    try {
      const { payload } = event;

      switch (payload.action) {
        case "workflow_run.completed":
          await this.handleWorkflowRunCompleted(payload.object);
          break;
        case "check.completed":
          await this.handleCheckCompleted(payload.object);
          break;
        default:
          console.log(`Unhandled webhook event: ${payload.action}`);
      }
    } catch (error) {
      console.error(
        `Failed to handle webhook: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      throw error;
    }
  }

  /**
   * Update user KYC level in database
   */
  async updateUserKYCLevel(userId: string, kycLevel: KYCLevel): Promise<void> {
    try {
      const query = `
        UPDATE users 
        SET kyc_level = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `;

      await this.db.query(query, [kycLevel, userId]);

      console.log(`Updated KYC level for user ${userId} to ${kycLevel}`);
    } catch (error) {
      console.error(
        `Failed to update user KYC level: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      throw error;
    }
  }

  /**
   * Get transaction limits for KYC level
   */
  getTransactionLimits(kycLevel: KYCLevel): {
    dailyLimit: number;
    perTransactionLimit: {
      min: number;
      max: number;
    };
  } {
    const limits = {
      [KYCLevel.NONE]: {
        dailyLimit: parseInt(process.env.LIMIT_UNVERIFIED || "0"),
        perTransactionLimit: {
          min: parseInt(process.env.MIN_TRANSACTION_AMOUNT || "100"),
          max: parseInt(process.env.MAX_TRANSACTION_AMOUNT || "1000000"),
        },
      },
      [KYCLevel.BASIC]: {
        dailyLimit: parseInt(process.env.LIMIT_BASIC || "100000"),
        perTransactionLimit: {
          min: parseInt(process.env.MIN_TRANSACTION_AMOUNT || "100"),
          max: parseInt(process.env.MAX_TRANSACTION_AMOUNT || "1000000"),
        },
      },
      [KYCLevel.FULL]: {
        dailyLimit: parseInt(process.env.LIMIT_FULL || "10000000"),
        perTransactionLimit: {
          min: parseInt(process.env.MIN_TRANSACTION_AMOUNT || "100"),
          max: parseInt(process.env.MAX_TRANSACTION_AMOUNT || "1000000"),
        },
      },
    };

    return limits[kycLevel] || limits[KYCLevel.NONE];
  }

  // Private helper methods

  private async storeApplicantReference(
    applicant: KYCApplicant,
  ): Promise<void> {
    try {
      const query = `
        INSERT INTO kyc_applicants (id, user_id, applicant_data, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          applicant_data = $3,
          updated_at = CURRENT_TIMESTAMP
      `;

      // Note: user_id should be passed from the calling service
      // For now, we'll store without user_id association
      await this.db.query(query, [
        applicant.id,
        null,
        JSON.stringify(applicant),
        applicant.created_at,
      ]);
    } catch (error) {
      console.error(
        `Failed to store applicant reference: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      // Don't throw here as this is not critical
    }
  }

  private determineOverallStatus(
    checks: KYCCheck[],
    reports: KYCReport[],
  ): KYCStatus {
    if (checks.length === 0 && reports.length === 0) {
      return KYCStatus.PENDING;
    }

    const hasRejected = reports.some(
      (report) => report.status === KYCStatus.REJECTED,
    );
    if (hasRejected) return KYCStatus.REJECTED;

    const hasReview = reports.some(
      (report) => report.status === KYCStatus.REVIEW,
    );
    if (hasReview) return KYCStatus.REVIEW;

    const allApproved = reports.every(
      (report) => report.status === KYCStatus.APPROVED,
    );
    if (allApproved) return KYCStatus.APPROVED;

    return KYCStatus.PENDING;
  }

  private determineKYCLevel(
    checks: KYCCheck[],
    reports: KYCReport[],
  ): KYCLevel {
    const documentReports = reports.filter(
      (report) =>
        report.name.includes("document") || report.name.includes("identity"),
    );

    if (documentReports.length === 0) {
      return KYCLevel.NONE;
    }

    const hasBasicDocuments = documentReports.some(
      (report) => report.status === KYCStatus.APPROVED,
    );

    if (!hasBasicDocuments) {
      return KYCLevel.NONE;
    }

    const hasAdvancedVerification = reports.some(
      (report) =>
        report.name.includes("facial") ||
        report.name.includes("address") ||
        report.name.includes("enhanced"),
    );

    return hasAdvancedVerification ? KYCLevel.FULL : KYCLevel.BASIC;
  }

  private async handleWorkflowRunCompleted(workflowRun: any): Promise<void> {
    try {
      // Get the applicant ID from the workflow run
      const applicantId = workflowRun.id;

      // Get verification status
      const verificationStatus = await this.getVerificationStatus(applicantId);

      // Find the associated user and update their KYC level
      const userQuery = `
        SELECT u.id FROM users u
        JOIN kyc_applicants ka ON u.id = ka.user_id
        WHERE ka.applicant_id = $1
      `;

      const result = await this.db.query(userQuery, [applicantId]);

      if (result.rows.length > 0) {
        const userId = result.rows[0].id;
        await this.updateUserKYCLevel(userId, verificationStatus.level);
      }
    } catch (error) {
      console.error(
        `Failed to handle workflow run completion: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private async handleCheckCompleted(check: any): Promise<void> {
    try {
      const applicantId = check.applicant_id;
      const verificationStatus = await this.getVerificationStatus(applicantId);

      // Find associated user and update if needed
      const userQuery = `
        SELECT u.id FROM users u
        JOIN kyc_applicants ka ON u.id = ka.user_id
        WHERE ka.applicant_id = $1
      `;

      const result = await this.db.query(userQuery, [applicantId]);

      if (result.rows.length > 0) {
        const userId = result.rows[0].id;
        await this.updateUserKYCLevel(userId, verificationStatus.level);
      }
    } catch (error) {
      console.error(
        `Failed to handle check completion: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}

export default KYCService;
