import twilio from "twilio";
import { SmsService, TransactionSmsContext, formatPhoneE164 } from "./sms";
import { resolveLocale, translate } from "../utils/i18n";

export interface WhatsappSendResult {
  sent: boolean;
  provider: "whatsapp" | "sms";
  messageSid?: string;
  error?: string;
  skippedReason?: string;
}

export class WhatsappService {
  private client: ReturnType<typeof twilio> | null = null;
  private smsService: SmsService;

  constructor(smsService?: SmsService) {
    this.smsService = smsService || new SmsService();
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (sid && token) {
      this.client = twilio(sid, token);
    }
  }

  private shouldSendWhatsApp(): boolean {
    const enabled = process.env.WHATSAPP_ENABLED === "true";
    return enabled && this.client !== null;
  }

  /**
   * Sends a message via WhatsApp with fallback to SMS.
   * WhatsApp requires pre-approved templates for business-initiated messages.
   */
  async sendWithFallback(
    toRaw: string,
    body: string,
    templateSid?: string,
    templateVariables?: Record<string, string>,
  ): Promise<WhatsappSendResult> {
    let to: string;
    try {
      to = formatPhoneE164(toRaw);
    } catch (e) {
      return {
        sent: false,
        provider: "whatsapp",
        skippedReason: "invalid_phone",
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER; // Format: whatsapp:+1234567890

    if (this.shouldSendWhatsApp() && whatsappFrom) {
      try {
        const messageParams: any = {
          from: whatsappFrom,
          to: `whatsapp:${to}`,
        };

        if (templateSid) {
          // Use Twilio Content SID / Template
          messageParams.contentSid = templateSid;
          if (templateVariables) {
            messageParams.contentVariables = JSON.stringify(templateVariables);
          }
        } else {
          // Regular text message (only works if a session is already open)
          messageParams.body = body;
        }

        const message = await this.client!.messages.create(messageParams);

        console.log("[whatsapp] delivered", {
          to,
          sid: message.sid,
          status: message.status,
        });

        return {
          sent: true,
          provider: "whatsapp",
          messageSid: message.sid,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[whatsapp] failed, falling back to SMS", { to, error: msg })

        // Fallback to SMS
        const smsResult = await this.smsService.sendToPhone(to, body);
        return {
          sent: smsResult.sent,
          provider: "sms",
          messageSid: smsResult.messageSid,
          error: smsResult.error,
          skippedReason: smsResult.skippedReason,
        };
      }
    }

    // WhatsApp disabled or missing config, go straight to SMS
    console.log("[whatsapp] skipped or not configured, using SMS instead");
    const smsResult = await this.smsService.sendToPhone(to, body);
    return {
      sent: smsResult.sent,
      provider: "sms",
      messageSid: smsResult.messageSid,
      error: smsResult.error,
      skippedReason: smsResult.skippedReason,
    };
  }

  /**
   * Notify transaction event via WhatsApp (with SMS fallback)
   */
  async notifyTransactionEvent(
    phoneNumber: string,
    ctx: TransactionSmsContext,
  ): Promise<WhatsappSendResult> {
    const locale = resolveLocale(ctx.locale);
    const body = this.buildTransactionMessage(ctx);

    // In a real production environment, you would use a Twilio Content SID (template)
    // for WhatsApp business-initiated messages.
    const templateSid = process.env.TWILIO_WHATSAPP_TRANSACTION_TEMPLATE_SID;
    const templateVariables = {
      "1": translate(`sms.action.${ctx.type}`, locale),
      "2": ctx.amount,
      "3": ctx.provider.toUpperCase(),
      "4": ctx.referenceNumber,
    };

    return this.sendWithFallback(phoneNumber, body, templateSid, templateVariables);
  }

  /**
   * Send OTP via WhatsApp (with SMS fallback)
   */
  async sendOTP(
    phoneNumber: string,
    otp: string,
    locale = "en",
  ): Promise<WhatsappSendResult> {
    const body = translate("whatsapp.otp", resolveLocale(locale), { otp });

    const templateSid = process.env.TWILIO_WHATSAPP_OTP_TEMPLATE_SID;
    const templateVariables = { "1": otp };

    return this.sendWithFallback(phoneNumber, body, templateSid, templateVariables);
  }

  private buildTransactionMessage(ctx: TransactionSmsContext): string {
    const locale = resolveLocale(ctx.locale);
    const action = translate(`sms.action.${ctx.type}`, locale);
    if (ctx.kind === "transaction_completed") {
      return translate("sms.transaction_completed", locale, {
        action,
        amount: ctx.amount,
        provider: ctx.provider.toUpperCase(),
        referenceNumber: ctx.referenceNumber,
      });
    } else {
      const detail = ctx.errorMessage
        ? translate("sms.reason_detail", locale, {
            reason: ctx.errorMessage.slice(0, 120),
          })
        : "";
      return translate("sms.transaction_failed", locale, {
        action,
        referenceNumber: ctx.referenceNumber,
        detail,
      });
    }
  }
}
