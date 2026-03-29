import sgMail from "@sendgrid/mail";
import { Transaction } from "../models/transaction";
import { resolveLocale, translate } from "../utils/i18n";

sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

export interface EmailOptions {
  to: string;
  templateId: string;
  dynamicTemplateData: Record<string, any>;
}

export class EmailService {
  private resolveTemplateId(
    baseEnvName: "SENDGRID_RECEIPT_TEMPLATE_ID" | "SENDGRID_FAILURE_TEMPLATE_ID",
    locale: string,
  ): string {
    const resolvedLocale = resolveLocale(locale).toUpperCase();
    const localizedEnvKey = `${baseEnvName}_${resolvedLocale}`;

    return process.env[localizedEnvKey] || process.env[baseEnvName] || "";
  }

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

  async sendTransactionReceipt(
    email: string,
    transaction: Transaction,
    locale = "en",
  ): Promise<void> {
    const resolvedLocale = resolveLocale(locale);
    await this.sendEmail({
      to: email,
      templateId: this.resolveTemplateId(
        "SENDGRID_RECEIPT_TEMPLATE_ID",
        resolvedLocale,
      ),
      dynamicTemplateData: {
        amount: transaction.amount,
        type: transaction.type,
        typeLocalized: translate(
          `email.transaction_type.${transaction.type}`,
          resolvedLocale,
        ),
        referenceNumber: transaction.referenceNumber,
        provider: transaction.provider.toUpperCase(),
        phoneNumber: transaction.phoneNumber,
        stellarAddress: transaction.stellarAddress,
        createdAt: new Date(transaction.createdAt).toLocaleString(resolvedLocale),
        locale: resolvedLocale,
        year: new Date().getFullYear(),
      },
    });
  }

  async sendTransactionFailure(
    email: string,
    transaction: Transaction,
    reason: string,
    locale = "en",
  ): Promise<void> {
    const resolvedLocale = resolveLocale(locale);
    await this.sendEmail({
      to: email,
      templateId: this.resolveTemplateId(
        "SENDGRID_FAILURE_TEMPLATE_ID",
        resolvedLocale,
      ),
      dynamicTemplateData: {
        amount: transaction.amount,
        type: transaction.type,
        typeLocalized: translate(
          `email.transaction_type.${transaction.type}`,
          resolvedLocale,
        ),
        referenceNumber: transaction.referenceNumber,
        reason,
        reasonLabel: translate("email.labels.reason", resolvedLocale),
        locale: resolvedLocale,
        year: new Date().getFullYear(),
      },
    });
  }
}
