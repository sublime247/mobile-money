import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import { z } from 'zod';
import { AccountingService } from './accounting';
import { type KYCRejectionReason } from '../config/kycRejectionReasons';
import {
  KYCLevel as AppKYCLevel,
  MAX_TRANSACTION_AMOUNT,
  MIN_TRANSACTION_AMOUNT,
  TRANSACTION_LIMITS,
} from '../config/limits';
import { isTransientError, withRetry } from './retry';

// KYC Provider: Entrust Identity Verification (formerly Onfido)
// Documentation: https://documentation.identity.entrust.com/api/latest/

export enum KYCLevel {
  NONE = 'none',
  UNVERIFIED = 'none',
  BASIC = 'basic',
  FULL = 'full',
}

export enum KYCStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  REVIEW = 'review',
}

export enum DocumentType {
  PASSPORT = 'passport',
  DRIVING_LICENSE = 'driving_license',
  NATIONAL_IDENTITY_CARD = 'national_identity_card',
  RESIDENCE_PERMIT = 'residence_permit',
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
  applicant_id?: string;
  result?: string;
  status?: string;
  created_at?: string;
  href?: string;
  reports?: KYCReport[];
}

export interface KYCReport {
  id: string;
  check_id?: string;
  name: string;
  status?: string;
  result?: string;
  breakdown?: KYCBreakdown[];
  created_at?: string;
  href?: string;
}

export interface KYCBreakdown {
  result?: string;
  name?: string;
  properties?: Record<string, any>;
}

export interface WorkflowRun {
  id: string;
  applicant_id?: string;
  workflow_id: string;
  status: string;
  created_at: string;
  completed_at?: string;
  href?: string;
  applicant?: {
    id?: string;
  };
}

export interface WebhookEvent {
  payload: {
    action: string;
    object: {
      id: string;
      type?: string;
      applicant_id?: string;
      applicant?: {
        id?: string;
      };
      completed_at?: string;
      status?: string;
      href?: string;
      [key: string]: unknown;
    };
    webhook_id?: string;
  };
}

export interface VerificationStatusResponse {
  status: KYCStatus;
  level: KYCLevel;
  checks: KYCCheck[];
  reports: KYCReport[];
  rejectionReason: KYCRejectionReason | null;
}

export interface BinaryDocumentUploadInput {
  applicant_id: string;
  type: DocumentType;
  side?: 'front' | 'back';
  filename: string;
  mimeType: string;
  fileBuffer: Buffer;
}

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
  side: z.enum(['front', 'back']).optional(),
  filename: z.string(),
  data: z.string(),
  mime_type: z.string().optional(),
});

const TRANSIENT_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 400,
  provider: 'entrust',
} as const;

const IDENTITY_REPORT_HINTS = /document|identity|proof|id/i;
const ADVANCED_REPORT_HINTS = /facial|face|selfie|biometric|address|enhanced/i;
const APPROVED_HINTS = /approve|approved|clear|pass|passed|success|successful/i;
const REVIEW_HINTS = /review|consider|caution|suspect|pending|manual/i;
const REJECTED_HINTS = /reject|rejected|decline|declined|fail|failed|denied|mismatch|expired|unsupported|fraud|forg/i;

export class KYCService {
  private api: AxiosInstance;
  private db: Pool;
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(db: Pool) {
    this.db = db;
    this.baseURL = process.env.KYC_API_URL || 'https://api.eu.onfido.com/v3.6';
    this.apiKey =
      process.env.KYC_API_KEY || (process.env.NODE_ENV === 'test' ? 'test_key' : '');

    if (!this.apiKey) {
      throw new Error('KYC_API_KEY environment variable is required');
    }

    this.api = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Token token=${this.apiKey}`,
      },
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    this.api.interceptors.request.use((config) => {
      console.log(`KYC API Request: ${config.method?.toUpperCase()} ${config.url}`);
      return config;
    });

    this.api.interceptors.response.use(
      (response) => {
        console.log(`KYC API Response: ${response.status} ${response.config.url}`);
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

  async createApplicant(
    applicantData: z.infer<typeof CreateApplicantSchema>,
  ): Promise<KYCApplicant> {
    try {
      const validatedData = CreateApplicantSchema.parse(applicantData);
      return await this.requestWithRetry(() =>
        this.api.post('/applicants', validatedData).then((response) => response.data as KYCApplicant),
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid applicant data: ${error.message}`);
      }
      throw new Error(
        `Failed to create KYC applicant: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getApplicant(applicantId: string): Promise<KYCApplicant> {
    try {
      return await this.requestWithRetry(() =>
        this.api.get(`/applicants/${applicantId}`).then((response) => response.data as KYCApplicant),
      );
    } catch (error) {
      throw new Error(
        `Failed to retrieve applicant: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async uploadDocument(documentData: z.infer<typeof UploadDocumentSchema>): Promise<any> {
    try {
      const validatedData = UploadDocumentSchema.parse(documentData);
      const mimeType =
        validatedData.mime_type || this.inferMimeTypeFromFilename(validatedData.filename);
      const fileBuffer = this.decodeBase64Document(validatedData.data);

      return await this.uploadDocumentBinary({
        applicant_id: validatedData.applicant_id,
        type: validatedData.type,
        side: validatedData.side,
        filename: validatedData.filename,
        mimeType,
        fileBuffer,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid document data: ${error.message}`);
      }
      throw new Error(
        `Failed to upload document: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async uploadDocumentBinary(documentData: BinaryDocumentUploadInput): Promise<any> {
    const formData = new FormData();
    formData.append('applicant_id', documentData.applicant_id);
    formData.append('type', documentData.type);
    if (documentData.side) {
      formData.append('side', documentData.side);
    }
    formData.append(
      'file',
      new Blob([documentData.fileBuffer], { type: documentData.mimeType }),
      documentData.filename,
    );

    return this.requestWithRetry(() =>
      this.api
        .post('/documents', formData, {
          timeout: 45000,
        })
        .then((response) => response.data),
    );
  }

  async createWorkflowRun(applicantId: string, workflowId?: string): Promise<WorkflowRun> {
    try {
      const workflowData = {
        applicant_id: applicantId,
        workflow_id: workflowId || process.env.KYC_DEFAULT_WORKFLOW_ID,
      };

      return await this.requestWithRetry(() =>
        this.api
          .post('/workflow_runs', workflowData)
          .then((response) => response.data as WorkflowRun),
      );
    } catch (error) {
      throw new Error(
        `Failed to create workflow run: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async generateSDKToken(applicantId: string, applicationId: string): Promise<string> {
    try {
      const response = await this.requestWithRetry(() =>
        this.api
          .post('/sdk_token', {
            applicant_id: applicantId,
            application_id: applicationId,
          })
          .then((result) => result.data),
      );

      return response.token;
    } catch (error) {
      throw new Error(
        `Failed to generate SDK token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getVerificationStatus(applicantId: string): Promise<VerificationStatusResponse> {
    try {
      const checks = await this.fetchChecks(applicantId);
      const reports = await this.fetchReports(applicantId);
      const normalized = this.normalizeVerification(checks, reports);

      return {
        ...normalized,
        checks,
        reports,
      };
    } catch (error) {
      throw new Error(
        `Failed to get verification status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async handleWebhook(event: WebhookEvent): Promise<void> {
    try {
      const payload = event.payload;
      const applicantId = await this.resolveApplicantId(payload.object);

      if (!applicantId) {
        console.warn(`Unable to resolve applicant for webhook action ${payload.action}`);
        return;
      }

      const verificationStatus = await this.getVerificationStatus(applicantId);
      await this.persistVerificationStatus(applicantId, verificationStatus, payload.action);
    } catch (error) {
      console.error(
        `Failed to handle webhook: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      throw error;
    }
  }

  async updateUserKYCLevel(userId: string, kycLevel: KYCLevel): Promise<void> {
    try {
      const query = `
        UPDATE users
        SET kyc_level = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `;

      await this.db.query(query, [this.toAppKYCLevel(kycLevel), userId]);

      console.log(`Updated KYC level for user ${userId} to ${kycLevel}`);
      try {
        if (kycLevel !== KYCLevel.UNVERIFIED) {
          const accountingSvc = new AccountingService();
          await accountingSvc.syncContactForUser(userId);
        }
      } catch (err) {
        console.error(
          `Failed to sync accounting contact after KYC update for user ${userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } catch (error) {
      console.error(
        `Failed to update user KYC level: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      throw error;
    }
  }

  getTransactionLimits(kycLevel: KYCLevel) {
    const appLevel = this.toAppKYCLevel(kycLevel);

    return {
      dailyLimit: TRANSACTION_LIMITS[appLevel],
      perTransactionLimit: {
        min: MIN_TRANSACTION_AMOUNT,
        max: MAX_TRANSACTION_AMOUNT,
      },
    };
  }

  private async fetchChecks(applicantId: string): Promise<KYCCheck[]> {
    const data = await this.requestWithRetry(() =>
      this.api
        .get(`/checks?applicant_id=${encodeURIComponent(applicantId)}`)
        .then((response) => response.data),
    );

    return Array.isArray(data.checks) ? (data.checks as KYCCheck[]) : [];
  }

  private async fetchReports(applicantId: string): Promise<KYCReport[]> {
    const data = await this.requestWithRetry(() =>
      this.api
        .get(`/reports?applicant_id=${encodeURIComponent(applicantId)}`)
        .then((response) => response.data),
    );

    return Array.isArray(data.reports) ? (data.reports as KYCReport[]) : [];
  }

  private normalizeVerification(
    checks: KYCCheck[],
    reports: KYCReport[],
  ): Omit<VerificationStatusResponse, 'checks' | 'reports'> {
    if (checks.length === 0 && reports.length === 0) {
      return {
        status: KYCStatus.PENDING,
        level: KYCLevel.UNVERIFIED,
        rejectionReason: null,
      };
    }

    const rejectionReason = this.detectRejectionReason(reports);
    const hasExplicitRejection = reports.some((report) =>
      this.isRejectedLike(this.getReportEvidence(report)),
    );
    const hasReview = reports.some((report) => this.isReviewLike(this.getReportEvidence(report)));

    if (rejectionReason === 'Fraudulent Document') {
      return {
        status: KYCStatus.REVIEW,
        level: KYCLevel.UNVERIFIED,
        rejectionReason,
      };
    }

    if (hasExplicitRejection || rejectionReason) {
      return {
        status: KYCStatus.REJECTED,
        level: KYCLevel.UNVERIFIED,
        rejectionReason,
      };
    }

    if (hasReview) {
      return {
        status: KYCStatus.REVIEW,
        level: KYCLevel.UNVERIFIED,
        rejectionReason: null,
      };
    }

    const documentReports = reports.filter((report) =>
      IDENTITY_REPORT_HINTS.test(report.name || ''),
    );
    const hasApprovedIdentity = documentReports.some((report) =>
      this.isApprovedLike(this.getReportEvidence(report)),
    );

    if (!hasApprovedIdentity) {
      return {
        status: KYCStatus.PENDING,
        level: KYCLevel.UNVERIFIED,
        rejectionReason: null,
      };
    }

    const hasAdvancedApproval = reports.some(
      (report) =>
        ADVANCED_REPORT_HINTS.test(report.name || '') &&
        this.isApprovedLike(this.getReportEvidence(report)),
    );

    return {
      status: KYCStatus.APPROVED,
      level: hasAdvancedApproval ? KYCLevel.FULL : KYCLevel.BASIC,
      rejectionReason: null,
    };
  }

  private detectRejectionReason(reports: KYCReport[]): KYCRejectionReason | null {
    const matches = (needle: RegExp) =>
      reports.some((report) => needle.test(this.getReportEvidence(report)));

    if (matches(/fraud|forg|tamper|counterfeit|fake|impersonat/i)) {
      return 'Fraudulent Document';
    }
    if (matches(/selfie mismatch|facial mismatch|face mismatch|photo mismatch|biometric mismatch/i)) {
      return 'Selfie Mismatch';
    }
    if (matches(/name mismatch/i)) {
      return 'Name Mismatch';
    }
    if (matches(/address mismatch/i)) {
      return 'Address Mismatch';
    }
    if (matches(/blur|blurry|glare|quality|obscured|unreadable/i)) {
      return 'Blurry ID';
    }
    if (matches(/expired|expiration|expiry/i)) {
      return 'Expired ID';
    }
    if (matches(/unsupported|unsupported document|document type/i)) {
      return 'Unsupported Document Type';
    }
    if (matches(/incomplete|missing/i)) {
      return 'Incomplete Information';
    }

    return null;
  }

  private getReportEvidence(report: KYCReport): string {
    const parts: string[] = [report.name || '', report.status || '', report.result || ''];

    for (const item of report.breakdown || []) {
      parts.push(item.name || '', item.result || '', JSON.stringify(item.properties || {}));
    }

    return parts.join(' ').toLowerCase();
  }

  private isApprovedLike(text: string): boolean {
    return APPROVED_HINTS.test(text) && !REJECTED_HINTS.test(text) && !REVIEW_HINTS.test(text);
  }

  private isReviewLike(text: string): boolean {
    return REVIEW_HINTS.test(text) && !REJECTED_HINTS.test(text);
  }

  private isRejectedLike(text: string): boolean {
    return REJECTED_HINTS.test(text);
  }

  private async resolveApplicantId(object: WebhookEvent['payload']['object']): Promise<string | null> {
    if (typeof object.applicant_id === 'string' && object.applicant_id) {
      return object.applicant_id;
    }

    if (typeof object.applicant?.id === 'string' && object.applicant.id) {
      return object.applicant.id;
    }

    if (!object.id) {
      return null;
    }

    if (object.type === 'workflow_run') {
      const workflowRun = await this.requestWithRetry(() =>
        this.api.get(`/workflow_runs/${object.id}`).then((response) => response.data as WorkflowRun),
      );
      return workflowRun.applicant_id || workflowRun.applicant?.id || null;
    }

    if (object.type === 'check') {
      const check = await this.requestWithRetry(() =>
        this.api.get(`/checks/${object.id}`).then((response) => response.data as KYCCheck),
      );
      return check.applicant_id || null;
    }

    return null;
  }

  private async persistVerificationStatus(
    applicantId: string,
    verification: VerificationStatusResponse,
    eventAction: string,
  ): Promise<void> {
    const updateResult = await this.db.query<{
      user_id: string | null;
      kyc_level: string | null;
    }>(
      `
        UPDATE kyc_applicants
        SET verification_status = $1,
            kyc_level = $2,
            rejection_reason = $3,
            applicant_data = COALESCE(applicant_data, '{}'::jsonb) || $4::jsonb,
            updated_at = CURRENT_TIMESTAMP
        WHERE applicant_id = $5
        RETURNING user_id, kyc_level
      `,
      [
        verification.status,
        verification.level,
        verification.rejectionReason,
        JSON.stringify({
          last_event_action: eventAction,
          last_verified_at: new Date().toISOString(),
          last_verification_snapshot: {
            status: verification.status,
            level: verification.level,
            rejectionReason: verification.rejectionReason,
            checks: verification.checks,
            reports: verification.reports,
          },
        }),
        applicantId,
      ],
    );

    const userId = updateResult.rows[0]?.user_id;
    if (userId && verification.status === KYCStatus.APPROVED) {
      await this.updateUserKYCLevel(userId, verification.level);
    }
  }

  private decodeBase64Document(data: string): Buffer {
    const normalized = data.includes(',') ? data.split(',').pop() || '' : data;
    const buffer = Buffer.from(normalized, 'base64');

    if (!buffer.length) {
      throw new Error('Document payload is empty');
    }

    return buffer;
  }

  private inferMimeTypeFromFilename(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.png')) return 'image/png';
    return 'image/jpeg';
  }

  private toAppKYCLevel(kycLevel: KYCLevel): AppKYCLevel {
    if (kycLevel === KYCLevel.FULL) return AppKYCLevel.Full;
    if (kycLevel === KYCLevel.BASIC) return AppKYCLevel.Basic;
    return AppKYCLevel.Unverified;
  }

  private async requestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, TRANSIENT_RETRY_OPTIONS);
    } catch (error) {
      if (isTransientError(error, 'entrust')) {
        throw new Error(
          `Entrust request failed after a transient network error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw error;
    }
  }
}

export default KYCService;
