import twilio from "twilio";
// @ts-ignore
import africastalking from "africastalking";
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import { resolveLocale, translate } from "../utils/i18n";

export type SmsEventKind = "transaction_completed" | "transaction_failed";

export interface TransactionSmsContext {
  referenceNumber: string;
  type: "deposit" | "withdraw";
  amount: string;
  provider: string;
  kind: SmsEventKind;
  errorMessage?: string;
  locale?: string;
}

/** Normalize to E.164; uses SMS_DEFAULT_REGION (ISO 3166-1 alpha-2) when number has no country code */
export function formatPhoneE164(
  raw: string,
  defaultRegion: CountryCode =
    (process.env.SMS_DEFAULT_REGION as CountryCode) || "CM",
): string {
  const trimmed = raw.trim();
  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  if (!parsed || !parsed.isValid()) {
    throw new Error(`Invalid phone number for SMS: ${raw}`);
  }
  return parsed.number; // E.164
}

function templateCompleted(ctx: TransactionSmsContext): string {
  const locale = resolveLocale(ctx.locale);
  const action = translate(`sms.action.${ctx.type}`, locale);
  return translate("sms.transaction_completed", locale, {
    action,
    amount: ctx.amount,
    provider: ctx.provider.toUpperCase(),
    referenceNumber: ctx.referenceNumber,
  });
}

function templateFailed(ctx: TransactionSmsContext): string {
  const locale = resolveLocale(ctx.locale);
  const action = translate(`sms.action.${ctx.type}`, locale);
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

export function buildTransactionSmsBody(ctx: TransactionSmsContext): string {
  return ctx.kind === "transaction_completed"
    ? templateCompleted(ctx)
    : templateFailed(ctx);
}

interface RateBucket {
  count: number;
  windowStart: number;
}

export class SmsRateLimiter {
  private buckets = new Map<string, RateBucket>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /** @returns true if under limit (and consumes one slot) */
  tryConsume(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (b.count >= this.maxPerWindow) return false;
    b.count += 1;
    return true;
  }
}

const globalLimiter = new SmsRateLimiter(
  parseInt(process.env.SMS_MAX_PER_PHONE_PER_HOUR || "10", 10),
  parseInt(process.env.SMS_RATE_LIMIT_WINDOW_MS || `${60 * 60 * 1000}`, 10),
);

export interface SmsSendResult {
  sent: boolean;
  skippedReason?: string;
  messageSid?: string;
  error?: string;
}

export class SmsService {
  private twilioClient: ReturnType<typeof twilio> | null = null;
  private atClient: any = null;
  private provider: string;

  constructor() {
    this.provider = (process.env.SMS_PROVIDER || "none").toLowerCase();
    if (this.provider === "twilio") {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      if (sid && token) this.twilioClient = twilio(sid, token);
    } else if (this.provider === "africastalking") {
      const apiKey = process.env.AFRICASTALKING_API_KEY;
      const username = process.env.AFRICASTALKING_USERNAME;
      if (apiKey && username) {
        this.atClient = africastalking({ apiKey, username });
      }
    }
  }

  shouldSend(): boolean {
    if (process.env.NODE_ENV === "test") return false;
    if (this.provider === "none" || this.provider === "off" || this.provider === "disabled")
      return false;
    return (this.provider === "twilio" && this.twilioClient !== null) || (this.provider === "africastalking" && this.atClient !== null);
  }

  async sendToPhone(toRaw: string, body: string): Promise<SmsSendResult> {
    if (!this.shouldSend()) {
      console.log("[sms] skipped (test env, SMS_PROVIDER=none, or missing Twilio config)");
      return { sent: false, skippedReason: "disabled_or_test" };
    }

    let to: string;
    try {
      to = formatPhoneE164(toRaw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[sms] invalid recipient", msg);
      return { sent: false, skippedReason: "invalid_phone", error: msg };
    }

    if (!globalLimiter.tryConsume(to)) {
      console.warn("[sms] rate limited", { to });
      return { sent: false, skippedReason: "rate_limited" };
    }

    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!from) {
      console.warn("[sms] TWILIO_PHONE_NUMBER not set");
      return { sent: false, skippedReason: "missing_from_number" };
    }

    try {
      let messageSidStr = "unknown";
      
      if (this.provider === "twilio") {
        const message = await this.twilioClient!.messages.create({
          to,
          from,
          body,
        });
        messageSidStr = message.sid;
        console.log("[sms] delivered via Twilio", {
          to,
          sid: message.sid,
          status: message.status,
        });
      } else if (this.provider === "africastalking") {
        const result = await this.atClient.SMS.send({
          to: [to],
          message: body,
          from: process.env.AFRICASTALKING_SENDER_ID
        });
        const msgData = result?.SMSMessageData?.Recipients?.[0];
        if (msgData?.status === "Success") {
          messageSidStr = msgData.messageId;
        } else {
          throw new Error(`AT sending failed with status: ${msgData?.status}`);
        }
        console.log("[sms] delivered via Africa's Talking", {
          to,
          sid: messageSidStr,
          status: msgData?.status,
        });
      }

      return { sent: true, messageSid: messageSidStr };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sms] send failed", { to, error: msg });
      return { sent: false, error: msg };
    }
  }

  async notifyTransactionEvent(
    phoneNumber: string,
    ctx: TransactionSmsContext,
  ): Promise<SmsSendResult> {
    const body = buildTransactionSmsBody(ctx);
    return this.sendToPhone(phoneNumber, body);
  }
}

export const smsService = new SmsService();
