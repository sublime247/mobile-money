import logger from "../utils/logger";
import crypto from "crypto";
import { MerchantModel, CreateMerchantInput, Merchant } from "../models/merchant";
import { EmailService } from "./email";
import { resolveLocale, translate } from "../utils/i18n";

export interface MerchantInvitationEmailData {
  merchantName: string;
  businessName?: string;
  invitationUrl: string;
  expiresAt: string;
  locale?: string;
}

export class MerchantService {
  private merchantModel: MerchantModel;
  private emailService: EmailService;

  constructor() {
    this.merchantModel = new MerchantModel();
    this.emailService = new EmailService();
  }

  async createMerchant(input: CreateMerchantInput): Promise<Merchant> {
    // Check if email already exists
    const existing = await this.merchantModel.findByEmail(input.email);
    if (existing) {
      throw new Error("A merchant with this email already exists");
    }

    const merchant = await this.merchantModel.create(input);
    
    // Send invitation email
    await this.sendInvitationEmail(merchant);
    
    await this.merchantModel.markInvitationSent(merchant.id);
    
    return merchant;
  }

  async bulkCreateMerchants(
    inputs: CreateMerchantInput[],
    createdBy: string
  ): Promise<{
    jobId: string;
    total: number;
    message: string;
    statusUrl: string;
  }> {
    if (inputs.length === 0) {
      throw new Error("No merchants provided for bulk creation");
    }

    // Limit batch size to prevent overwhelming the system
    const MAX_BATCH_SIZE = 1000;
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new Error(`Maximum batch size is ${MAX_BATCH_SIZE} merchants`);
    }

    const jobId = crypto.randomUUID();
    
    // Create batch job record
    await this.merchantModel.createBatchJob(jobId, inputs.length, createdBy);

    // Process in background
    setImmediate(() => this.processBulkImport(jobId, inputs, createdBy));

    return {
      jobId,
      total: inputs.length,
      message: `Bulk merchant import queued - ${inputs.length} merchant(s) will be processed`,
      statusUrl: `/api/merchants/bulk/${jobId}`,
    };
  }

  private async processBulkImport(
    jobId: string,
    inputs: CreateMerchantInput[],
    createdBy: string
  ): Promise<void> {
    await this.merchantModel.updateBatchJob(jobId, { status: "processing" });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const errors: Array<{ row: number; error: string; email?: string }> = [];

    // Filter out duplicates by email first
    const uniqueInputs = this.deduplicateByEmail(inputs);
    
    // Pre-validate all inputs
    const validationErrors = this.validateAllInputs(uniqueInputs);
    
    if (validationErrors.length > 0) {
      // If there are validation errors, we still try to process valid ones
      const validInputs = uniqueInputs.filter((_, index) => {
        const rowErrors = validationErrors.filter(e => e.row === index + 2);
        return rowErrors.length === 0;
      });
      
      errors.push(...validationErrors);
      failed += validationErrors.length;
      
      // Process valid inputs
      if (validInputs.length > 0) {
        const result = await this.merchantModel.createMany(validInputs, createdBy);
        succeeded += result.created.length;
        errors.push(...result.errors);
        failed += result.errors.length;
        
        // Send invitation emails for created merchants
        for (const merchant of result.created) {
          try {
            await this.sendInvitationEmail(merchant);
            await this.merchantModel.markInvitationSent(merchant.id);
          } catch (emailError) {
            logger.error(`[MerchantService] Failed to send invitation email to ${merchant.email}:`, emailError);
          }
        }
      }
    } else {
      // All inputs are valid, process all
      const result = await this.merchantModel.createMany(uniqueInputs, createdBy);
      succeeded += result.created.length;
      errors.push(...result.errors);
      failed += result.errors.length;
      
      // Send invitation emails for created merchants
      for (const merchant of result.created) {
        try {
          await this.sendInvitationEmail(merchant);
          await this.merchantModel.markInvitationSent(merchant.id);
        } catch (emailError) {
          logger.error(`[MerchantService] Failed to send invitation email to ${merchant.email}:`, emailError);
        }
      }
    }

    processed = succeeded + failed;

    await this.merchantModel.updateBatchJob(jobId, {
      status: "completed",
      processedRecords: processed,
      succeededRecords: succeeded,
      failedRecords: failed,
      errors,
      completedAt: new Date(),
    });
  }

  private deduplicateByEmail(inputs: CreateMerchantInput[]): CreateMerchantInput[] {
    const seen = new Set<string>();
    const unique: CreateMerchantInput[] = [];
    
    for (const input of inputs) {
      const email = input.email.toLowerCase().trim();
      if (!seen.has(email)) {
        seen.add(email);
        unique.push(input);
      }
    }
    
    return unique;
  }

  private validateAllInputs(inputs: CreateMerchantInput[]): Array<{ row: number; error: string; email?: string }> {
    const errors: Array<{ row: number; error: string; email?: string }> = [];
    
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const rowNum = i + 2; // Row 1 is header
      
      const validationErrors = this.validateMerchantInput(input, rowNum);
      errors.push(...validationErrors);
    }
    
    return errors;
  }

  private validateMerchantInput(input: CreateMerchantInput, rowNum: number): Array<{ row: number; error: string; email?: string }> {
    const errors: Array<{ row: number; error: string; email?: string }> = [];
    
    // Validate name
    if (!input.name || input.name.trim().length === 0) {
      errors.push({ row: rowNum, error: "Name is required", email: input.email });
    } else if (input.name.length > 255) {
      errors.push({ row: rowNum, error: "Name must be less than 255 characters", email: input.email });
    }
    
    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!input.email || !emailRegex.test(input.email)) {
      errors.push({ row: rowNum, error: "Valid email is required", email: input.email });
    } else if (input.email.length > 255) {
      errors.push({ row: rowNum, error: "Email must be less than 255 characters", email: input.email });
    }
    
    // Validate phone number
    const phoneRegex = /^\+?\d{7,15}$/;
    if (!input.phoneNumber || !phoneRegex.test(input.phoneNumber.replace(/[\s\-()]/g, ''))) {
      errors.push({ row: rowNum, error: "Valid phone number is required (7-15 digits)", email: input.email });
    }
    
    // Validate country code (ISO 3166-1 alpha-2)
    if (input.country && !/^[A-Z]{2}$/.test(input.country.toUpperCase())) {
      errors.push({ row: rowNum, error: "Country must be a valid ISO 3166-1 alpha-2 code", email: input.email });
    }
    
    // Validate business type if provided
    if (input.businessType && input.businessType.length > 100) {
      errors.push({ row: rowNum, error: "Business type must be less than 100 characters", email: input.email });
    }
    
    // Validate tax ID if provided
    if (input.taxId && input.taxId.length > 50) {
      errors.push({ row: rowNum, error: "Tax ID must be less than 50 characters", email: input.email });
    }
    
    return errors;
  }

  private async sendInvitationEmail(merchant: Merchant, locale = "en"): Promise<void> {
    const resolvedLocale = resolveLocale(locale);
    const invitationUrl = `${process.env.FRONTEND_URL || "https://app.mobilemoney.com"}/merchant/invite/${merchant.invitationToken}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    
    const emailData: MerchantInvitationEmailData = {
      merchantName: merchant.name,
      businessName: merchant.businessName,
      invitationUrl,
      expiresAt: new Date(expiresAt).toLocaleString(resolvedLocale),
      locale: resolvedLocale,
    };

    const templateId = process.env.SENDGRID_MERCHANT_INVITATION_TEMPLATE_ID;
    
    if (templateId) {
      await this.emailService.sendEmail({
        to: merchant.email,
        templateId,
        dynamicTemplateData: {
          ...emailData,
          year: new Date().getFullYear(),
        },
      });
    } else {
      // Fallback to inline HTML email
      await this.emailService.sendEmail({
        to: merchant.email,
        templateId: "",
        dynamicTemplateData: {},
      });
      
      // Direct send for fallback
      const sgMail = require("@sendgrid/mail");
      const from = process.env.EMAIL_FROM || '"Mobile Money" <no-reply@mobilemoney.com>';
      
      try {
        await sgMail.send({
          from,
          to: merchant.email,
          subject: translate("email.merchant_invitation.subject", resolvedLocale),
          html: this.buildInvitationEmailHtml(emailData, resolvedLocale),
          text: this.buildInvitationEmailText(emailData, resolvedLocale),
        });
      } catch (error) {
        logger.error("[MerchantService] Invitation email delivery failed:", error);
      }
    }
  }

  private buildInvitationEmailHtml(data: MerchantInvitationEmailData, locale: string): string {
    return `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#2c3e50;">Welcome to Mobile Money!</h2>
        <p>Hello ${data.merchantName}${data.businessName ? ` from ${data.businessName}` : ""},</p>
        <p>You've been invited to join our merchant network. Click the button below to accept your invitation and complete your registration.</p>
        <div style="text-align:center;margin:30px 0;">
          <a href="${data.invitationUrl}" 
             style="background-color:#3498db;color:white;padding:12px 30px;text-decoration:none;border-radius:5px;display:inline-block;">
            Accept Invitation
          </a>
        </div>
        <p style="color:#666;font-size:14px;">
          This invitation will expire on ${data.expiresAt}.
        </p>
        <p style="color:#666;font-size:14px;">
          If you didn't expect this invitation, please ignore this email.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
        <p style="color:#999;font-size:12px;text-align:center;">
          &copy; ${new Date().getFullYear()} Mobile Money. All rights reserved.
        </p>
      </div>
    `;
  }

  private buildInvitationEmailText(data: MerchantInvitationEmailData, locale: string): string {
    return `
Hello ${data.merchantName}${data.businessName ? ` from ${data.businessName}` : ""},

You've been invited to join our merchant network. Visit the link below to accept your invitation:

${data.invitationUrl}

This invitation will expire on ${data.expiresAt}.

If you didn't expect this invitation, please ignore this email.

---
© ${new Date().getFullYear()} Mobile Money. All rights reserved.
    `.trim();
  }

  async getBatchJobStatus(jobId: string) {
    const job = await this.merchantModel.getBatchJob(jobId);
    if (!job) {
      return null;
    }

    return {
      jobId: job.jobId,
      status: job.status,
      progress: {
        total: job.totalRecords,
        processed: job.processedRecords,
        succeeded: job.succeededRecords,
        failed: job.failedRecords,
      },
      errors: job.errors,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  async acceptInvitation(token: string): Promise<Merchant | null> {
    const merchant = await this.merchantModel.findByInvitationToken(token);
    if (!merchant) {
      return null;
    }

    return this.merchantModel.acceptInvitation(merchant.id);
  }

  async getMerchant(id: string): Promise<Merchant | null> {
    return this.merchantModel.findById(id);
  }

  async listMerchants(options?: {
    page?: number;
    limit?: number;
    status?: string;
    kycStatus?: string;
  }): Promise<{ merchants: Merchant[]; total: number; pagination: any }> {
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    
    const result = await this.merchantModel.list(options);
    
    return {
      ...result,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      },
    };
  }
}

