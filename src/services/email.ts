import sgMail from "@sendgrid/mail";
import { Transaction } from "../models/transaction";

sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

export interface EmailOptions {
  to: string;
  templateId: string,
  dynamicTemplateData: Record<string, any>
}

export class EmailService {
  async sendEmail(options: EmailOptions): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      console.log("Skipping email send in test environment");
      return;
    }

    try {
      await sgMail.send({
        from: process.env.EMAIL_FROM || '"Mobile Money" <no-reply@mobilemoney.com>',
        ...options
      });
    } catch (error) {
      console.error("Email delivery failed:", error);
      // We don't throw here to prevent blocking the transaction flow
      // but in a real app, we might want to retry or log to a dedicated service
    }
  }

  async sendTransactionReceipt(email: string, transaction: Transaction): Promise<void> {
    await this.sendEmail({
      to: email, templateId: process.env.SENDGRID_RECEIPT_TEMPLATE_ID || "", dynamicTemplateData: {
        amount: transaction.amount,
        type: transaction.type,
        referenceNumber: transaction.referenceNumber,
        provider: transaction.provider.toUpperCase(),
        phoneNumber: transaction.phoneNumber,
        stellarAddress: transaction.stellarAddress,
        createdAt: new Date(transaction.createdAt).toLocaleString(),
        year: new Date().getFullYear(),
      }
    });
  }

  async sendTransactionFailure(email: string, transaction: Transaction, reason: string): Promise<void> {
    await this.sendEmail({
      to: email, templateId: process.env.SENDGRID_FAILURE_TEMPLATE_ID || "", dynamicTemplateData: {
        amount: transaction.amount,
        type: transaction.type,
        referenceNumber: transaction.referenceNumber,
        reason,
        year: new Date().getFullYear(),
      }
    });
  }
}
