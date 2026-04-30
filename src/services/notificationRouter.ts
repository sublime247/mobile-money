import { EmailService, emailService } from "./email";
import { SmsService, smsService } from "./sms";
import { PushNotificationService, pushNotificationService } from "./push";
import { WhatsappService, whatsappService } from "./whatsapp";
import { PagerDutyService, pagerDutyService } from "./pagerDutyService";
import { UserModel } from "../models/users";
import { Transaction } from "../models/transaction";

export type NotificationSeverity = "low" | "medium" | "high" | "critical";

export type NotificationChannel = "email" | "sms" | "push" | "whatsapp" | "pagerduty";

export interface NotificationContext {
  userId?: string;
  transactionId?: string;
  transaction?: Transaction;
  severity: NotificationSeverity;
  category: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  locale?: string;
}

export interface NotificationRoutingRule {
  severity: NotificationSeverity;
  channels: NotificationChannel[];
  required: boolean; // If true, notification must be sent even if user preferences disable it
}

export interface UserNotificationPreferences {
  email: boolean;
  sms: boolean;
  push: boolean;
  whatsapp: boolean;
  severityThreshold: NotificationSeverity; // Minimum severity to notify
}

/**
 * Advanced Notification Router
 *
 * Routes notifications by severity to appropriate channels based on:
 * - Notification severity level
 * - User preferences
 * - Channel availability
 * - Business rules
 */
export class NotificationRouter {
  private emailService: EmailService;
  private smsService: SmsService;
  private pushService: PushNotificationService;
  private whatsappService: WhatsappService;
  private pagerDutyService: PagerDutyService;
  private userModel: UserModel;

  // Default routing rules by severity
  private readonly routingRules: Record<NotificationSeverity, NotificationRoutingRule> = {
    low: {
      severity: "low",
      channels: ["push"],
      required: false,
    },
    medium: {
      severity: "medium",
      channels: ["email", "push", "sms"],
      required: false,
    },
    high: {
      severity: "high",
      channels: ["email", "push", "sms", "whatsapp"],
      required: false,
    },
    critical: {
      severity: "critical",
      channels: ["email", "push", "sms", "whatsapp", "pagerduty"],
      required: true,
    },
  };

  // Default user preferences
  private readonly defaultPreferences: UserNotificationPreferences = {
    email: true,
    sms: true,
    push: true,
    whatsapp: false, // WhatsApp requires opt-in
    severityThreshold: "medium",
  };

  constructor(userModel: UserModel) {
    this.emailService = emailService;
    this.smsService = smsService;
    this.pushService = pushNotificationService;
    this.whatsappService = whatsappService;
    this.pagerDutyService = pagerDutyService;
    this.userModel = userModel;
  }

  /**
   * Get user notification preferences
   */
  private async getUserPreferences(userId: string): Promise<UserNotificationPreferences> {
    try {
      const user = await this.userModel.findById(userId);
      if (!user) {
        return this.defaultPreferences;
      }

      // In a real implementation, preferences would be stored in user profile
      // For now, return defaults with user's language preference
      return {
        ...this.defaultPreferences,
        // Could be extended to read from user.notificationPreferences field
      };
    } catch (error) {
      console.error(`Failed to get user preferences for ${userId}:`, error);
      return this.defaultPreferences;
    }
  }

  /**
   * Check if severity meets user's threshold
   */
  private meetsSeverityThreshold(
    severity: NotificationSeverity,
    threshold: NotificationSeverity,
  ): boolean {
    const severityLevels: Record<NotificationSeverity, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    return severityLevels[severity] >= severityLevels[threshold];
  }

  /**
   * Filter channels based on user preferences and severity
   */
  private async getEnabledChannels(
    context: NotificationContext,
    rule: NotificationRoutingRule,
  ): Promise<NotificationChannel[]> {
    if (rule.required) {
      // Critical notifications always go through all channels
      return rule.channels;
    }

    if (!context.userId) {
      // System notifications without user context use all channels
      return rule.channels;
    }

    const preferences = await this.getUserPreferences(context.userId);

    // Check if notification meets user's severity threshold
    if (!this.meetsSeverityThreshold(context.severity, preferences.severityThreshold)) {
      return [];
    }

    // Filter channels based on user preferences
    return rule.channels.filter((channel) => {
      switch (channel) {
        case "email":
          return preferences.email;
        case "sms":
          return preferences.sms;
        case "push":
          return preferences.push;
        case "whatsapp":
          return preferences.whatsapp;
        case "pagerduty":
          return true; // System alerts always go to PagerDuty if configured
        default:
          return false;
      }
    });
  }

  /**
   * Send notification through specified channel
   */
  private async sendToChannel(
    channel: NotificationChannel,
    context: NotificationContext,
  ): Promise<void> {
    try {
      switch (channel) {
        case "email":
          await this.sendEmailNotification(context);
          break;
        case "sms":
          await this.sendSmsNotification(context);
          break;
        case "push":
          await this.sendPushNotification(context);
          break;
        case "whatsapp":
          await this.sendWhatsappNotification(context);
          break;
        case "pagerduty":
          await this.sendPagerDutyNotification(context);
          break;
      }
    } catch (error) {
      console.error(`Failed to send ${channel} notification:`, error);
      // Don't throw - we don't want one channel failure to stop others
    }
  }

  private async sendEmailNotification(context: NotificationContext): Promise<void> {
    if (!context.userId) return;

    const user = await this.userModel.findById(context.userId);
    if (!user?.email) return;

    // For transaction notifications, use existing email service
    if (context.transaction && context.category === "transaction") {
      if (context.severity === "high" || context.severity === "critical") {
        await this.emailService.sendTransactionFailure(
          user.email,
          context.transaction,
          context.message,
          context.locale || user.preferredLanguage,
        );
      } else {
        await this.emailService.sendTransactionReceipt(
          user.email,
          context.transaction,
          context.locale || user.preferredLanguage,
        );
      }
    } else {
      // Generic email notification
      await this.emailService.sendEmail({
        to: user.email,
        templateId: process.env.SENDGRID_GENERAL_TEMPLATE_ID || "",
        dynamicTemplateData: {
          title: context.title,
          message: context.message,
          severity: context.severity,
          category: context.category,
          ...context.data,
        },
      });
    }
  }

  private async sendSmsNotification(context: NotificationContext): Promise<void> {
    if (!context.transaction) return;

    const eventKind: "transaction_completed" | "transaction_failed" =
      context.severity === "high" || context.severity === "critical"
        ? "transaction_failed"
        : "transaction_completed";

    await this.smsService.notifyTransactionEvent(context.transaction.phoneNumber, {
      referenceNumber: context.transaction.referenceNumber,
      type: context.transaction.type as "deposit" | "withdraw",
      amount: String(context.transaction.amount),
      provider: context.transaction.provider,
      kind: eventKind,
      errorMessage: context.severity === "high" || context.severity === "critical" ? context.message : undefined,
      locale: context.locale,
    });
  }

  private async sendPushNotification(context: NotificationContext): Promise<void> {
    if (!context.userId || !context.transaction) return;

    if (context.severity === "high" || context.severity === "critical") {
      await this.pushService.sendTransactionFailed(context.userId, {
        transactionId: context.transaction.id,
        referenceNumber: context.transaction.referenceNumber,
        type: context.transaction.type as "deposit" | "withdraw",
        amount: String(context.transaction.amount),
        status: "failed",
        error: context.message,
        data: context.data,
      });
    } else {
      await this.pushService.sendTransactionComplete(context.userId, {
        transactionId: context.transaction.id,
        referenceNumber: context.transaction.referenceNumber,
        type: context.transaction.type as "deposit" | "withdraw",
        amount: String(context.transaction.amount),
        status: "completed",
        data: context.data,
      });
    }
  }

  private async sendWhatsappNotification(context: NotificationContext): Promise<void> {
    if (!context.transaction) return;

    const eventKind: "transaction_completed" | "transaction_failed" =
      context.severity === "high" || context.severity === "critical"
        ? "transaction_failed"
        : "transaction_completed";

    await this.whatsappService.notifyTransactionEvent(context.transaction.phoneNumber, {
      referenceNumber: context.transaction.referenceNumber,
      type: context.transaction.type as "deposit" | "withdraw",
      amount: String(context.transaction.amount),
      provider: context.transaction.provider,
      kind: eventKind,
      errorMessage: context.severity === "high" || context.severity === "critical" ? context.message : undefined,
      locale: context.locale,
    });
  }

  private async sendPagerDutyNotification(context: NotificationContext): Promise<void> {
    // Only send critical system notifications to PagerDuty
    if (context.severity !== "critical") return;

    // This would integrate with PagerDuty for system alerts
    // For now, we'll use the existing PagerDuty service for provider monitoring
    console.log(`PagerDuty alert: ${context.title} - ${context.message}`);
  }

  /**
   * Route and send notification based on severity
   */
  async routeNotification(context: NotificationContext): Promise<void> {
    const rule = this.routingRules[context.severity];
    if (!rule) {
      console.warn(`No routing rule found for severity: ${context.severity}`);
      return;
    }

    const enabledChannels = await this.getEnabledChannels(context, rule);

    if (enabledChannels.length === 0) {
      console.log(`No enabled channels for notification: ${context.category} (${context.severity})`);
      return;
    }

    console.log(
      `Routing ${context.severity} notification to channels: ${enabledChannels.join(", ")}`,
    );

    // Send to all enabled channels in parallel
    const sendPromises = enabledChannels.map((channel) =>
      this.sendToChannel(channel, context),
    );

    await Promise.allSettled(sendPromises);
  }

  /**
   * Convenience method for transaction notifications
   */
  async routeTransactionNotification(
    transaction: Transaction,
    status: "completed" | "failed",
    errorMessage?: string,
  ): Promise<void> {
    const severity: NotificationSeverity = status === "failed" ? "high" : "medium";
    const title = status === "failed" ? "Transaction Failed" : "Transaction Completed";
    const message = errorMessage || `Your ${transaction.type} of ${transaction.amount} ${transaction.provider.toUpperCase()} has ${status}`;

    await this.routeNotification({
      userId: transaction.userId,
      transactionId: transaction.id,
      transaction,
      severity,
      category: "transaction",
      title,
      message,
      locale: "en", // Could be retrieved from user preferences
    });
  }

  /**
   * Convenience method for system notifications
   */
  async routeSystemNotification(
    severity: NotificationSeverity,
    category: string,
    title: string,
    message: string,
    data?: Record<string, any>,
  ): Promise<void> {
    await this.routeNotification({
      severity,
      category,
      title,
      message,
      data,
    });
  }
}

export const notificationRouter = new NotificationRouter(new UserModel());