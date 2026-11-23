/**
 * Orange Money dynamic QR codes (#1968).
 *
 * Generates merchant dynamic QR codes for Orange Money wallet scan-to-pay
 * flows used in physical retail and desktop checkout. The payload is an
 * EMVCo-compliant merchant-presented-mode (MPM) string with Orange Money
 * merchant account information, so any wallet that understands EMVCo QR can
 * scan it.
 *
 * Structure:
 *   - Tag 00 Payload Format Indicator
 *   - Tag 01 Point of Initiation Method (11 static / 12 dynamic)
 *   - Tag 26 Merchant Account Information (GUID = orange.om)
 *   - Tag 52 Merchant Category Code
 *   - Tag 53 Transaction Currency (ISO 4217 numeric)
 *   - Tag 54 Transaction Amount
 *   - Tag 58 Country Code
 *   - Tag 59 Merchant Name
 *   - Tag 60 Merchant City
 *   - Tag 62 Additional Data (bill/reference label)
 *   - Tag 63 CRC-16/CCITT-FALSE
 */

import QRCode from "qrcode";
import { Router, Request, Response } from "express";
import logger from "../../utils/logger";
import { TransactionModel, TransactionStatus } from "../../models/transaction";

// ─── Payload options ────────────────────────────────────────────────────────

export interface OrangeQrPayloadOptions {
  /** Orange Money merchant / till id. */
  merchantId: string;
  /** Amount to collect. */
  amount: number | string;
  /** ISO 4217 alphabetic code (e.g. "KES", "XOF") or numeric code. */
  currency?: string;
  /** ISO 3166-1 alpha-2 country code; defaults per currency. */
  countryCode?: string;
  merchantName?: string;
  merchantCity?: string;
  merchantCategoryCode?: string;
  /** Reference / bill number carried in Additional Data (tag 62). */
  reference?: string;
  storeLabel?: string;
  terminalLabel?: string;
  /** "dynamic" (amount present) or "static" (no amount). */
  pointOfInitiation?: "dynamic" | "static";
}

export interface OrangeQrCode {
  payload: string;
  dataUrl: string;
  merchantId: string;
  amount: string;
  currency: string;
  reference?: string;
}

// ─── Currency / country reference data ──────────────────────────────────────

/** ISO 4217 numeric codes for the Orange Money corridors. */
export const ORANGE_CURRENCY_CODES: Record<string, string> = {
  KES: "404",
  NGN: "566",
  GHS: "936",
  UGX: "800",
  RWF: "646",
  TZS: "834",
  ZMW: "967",
  MZN: "943",
  XAF: "950",
  XOF: "952",
  MAD: "504",
  TND: "788",
  EGP: "818",
  ZAR: "710",
  USD: "840",
  EUR: "978",
};

const CURRENCY_COUNTRY: Record<string, string> = {
  KES: "KE",
  NGN: "NG",
  GHS: "GH",
  UGX: "UG",
  RWF: "RW",
  TZS: "TZ",
  ZMW: "ZM",
  MZN: "MZ",
  XAF: "CM",
  XOF: "SN",
  MAD: "MA",
  TND: "TN",
  EGP: "EG",
  ZAR: "ZA",
  USD: "US",
  EUR: "FR",
};

/** EMVCo merchant account GUID for Orange Money. */
export const ORANGE_MERCHANT_ACCOUNT_GUID = "orange.om";

// ─── TLV + CRC helpers ──────────────────────────────────────────────────────

/** Encode a single EMVCo TLV element (2-digit length, 2-char tag). */
export function encodeTlv(tag: string, value: string): string {
  const length = String(value.length).padStart(2, "0");
  if (value.length > 99) {
    throw new Error(`TLV value for tag ${tag} exceeds 99 characters`);
  }
  return `${tag}${length}${value}`;
}

/**
 * CRC-16/CCITT-FALSE as required by EMVCo tag 63.
 * Polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR.
 */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Append the CRC tag to an otherwise-complete payload. */
export function appendCrc(payloadWithoutCrc: string): string {
  const withTag = `${payloadWithoutCrc}6304`;
  return `${withTag}${crc16(withTag)}`;
}

// ─── Payload builder ────────────────────────────────────────────────────────

/** Build an EMVCo-compliant Orange Money merchant QR payload. */
export function buildOrangeMoneyQrPayload(
  options: OrangeQrPayloadOptions,
): string {
  if (!options?.merchantId) {
    throw new Error("Orange Money QR payload requires a merchantId");
  }

  const currency = (options.currency ?? "XOF").toUpperCase();
  const numericCurrency = ORANGE_CURRENCY_CODES[currency];
  if (!numericCurrency) {
    throw new Error(`Unsupported Orange Money currency: ${currency}`);
  }

  const amount = Number(options.amount);
  const isStatic = options.pointOfInitiation === "static" || !(amount > 0);

  let payload = "";
  payload += encodeTlv("00", "01");
  payload += encodeTlv("01", isStatic ? "11" : "12");

  // Merchant Account Information template (tag 26)
  let merchantAccount = encodeTlv("00", ORANGE_MERCHANT_ACCOUNT_GUID);
  merchantAccount += encodeTlv("01", options.merchantId);
  if (options.reference) merchantAccount += encodeTlv("02", options.reference);
  if (options.storeLabel) merchantAccount += encodeTlv("03", options.storeLabel);
  if (options.terminalLabel) {
    merchantAccount += encodeTlv("04", options.terminalLabel);
  }
  payload += encodeTlv("26", merchantAccount);

  payload += encodeTlv("52", options.merchantCategoryCode ?? "0000");
  payload += encodeTlv("53", numericCurrency);
  if (!isStatic) {
    payload += encodeTlv("54", amount.toFixed(2));
  }
  payload += encodeTlv(
    "58",
    options.countryCode ?? CURRENCY_COUNTRY[currency] ?? "SN",
  );
  payload += encodeTlv("59", (options.merchantName ?? "Orange Money").slice(0, 25));
  payload += encodeTlv("60", (options.merchantCity ?? "Nairobi").slice(0, 15));

  if (options.reference) {
    const additional = encodeTlv("05", options.reference.slice(0, 25));
    payload += encodeTlv("62", additional);
  }

  return appendCrc(payload);
}

// ─── Generator ──────────────────────────────────────────────────────────────

export interface OrangeQrCodeGeneratorOptions {
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  width?: number;
  margin?: number;
}

export class OrangeQrCodeGenerator {
  private readonly errorCorrectionLevel: "L" | "M" | "Q" | "H";
  private readonly width: number;
  private readonly margin: number;

  constructor(options: OrangeQrCodeGeneratorOptions = {}) {
    this.errorCorrectionLevel = options.errorCorrectionLevel ?? "M";
    this.width = options.width ?? 256;
    this.margin = options.margin ?? 1;
  }

  /** Build the raw EMVCo payload (no image generation). */
  buildPayload(options: OrangeQrPayloadOptions): string {
    return buildOrangeMoneyQrPayload(options);
  }

  private toQrOptions() {
    return {
      errorCorrectionLevel: this.errorCorrectionLevel,
      width: this.width,
      margin: this.margin,
    };
  }

  /** PNG data URL (`data:image/png;base64,...`) suitable for an `<img src>`. */
  async generateDataUrl(payload: string): Promise<string> {
    return QRCode.toDataURL(payload, this.toQrOptions());
  }

  /** Raw base64 PNG (no `data:` prefix). */
  async generatePngBase64(payload: string): Promise<string> {
    const dataUrl = await this.generateDataUrl(payload);
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  }

  /** PNG buffer, e.g. for streaming as an HTTP response. */
  async generateBuffer(payload: string): Promise<Buffer> {
    return QRCode.toBuffer(payload, this.toQrOptions());
  }

  /** Build the payload + rendered data URL in one call. */
  async generate(options: OrangeQrPayloadOptions): Promise<OrangeQrCode> {
    const payload = this.buildPayload(options);
    const dataUrl = await this.generateDataUrl(payload);

    const currency = (options.currency ?? "XOF").toUpperCase();
    const amount = Number(options.amount);

    return {
      payload,
      dataUrl,
      merchantId: options.merchantId,
      amount: Number.isFinite(amount) ? amount.toFixed(2) : "0.00",
      currency,
      reference: options.reference,
    };
  }
}

// ─── SEP-24 embed ───────────────────────────────────────────────────────────

/**
 * Render the Orange Money scan-to-pay card that is embedded into the SEP-24
 * interactive deposit page. The QR is a base64 data URL so the page needs no
 * additional network requests.
 */
export function renderOrangeMoneyQrSection(qr: {
  dataUrl: string;
  merchantId: string;
  amount: string;
  currency: string;
  reference?: string;
}): string {
  const reference = qr.reference
    ? `<p class="orange-qr-ref">Reference: <strong>${escapeHtml(
        qr.reference,
      )}</strong></p>`
    : "";

  return `
    <section class="section orange-qr-section" id="orange-money-qr">
      <div class="container text-center">
        <h2 class="section-title">Pay with Orange Money</h2>
        <p class="section-subtitle">Scan the QR code with the Orange Money app to complete your deposit.</p>
        <div class="orange-qr-card">
          <img src="${qr.dataUrl}" alt="Orange Money payment QR code" width="224" height="224" />
          <p class="orange-qr-amount">${escapeHtml(
            qr.amount,
          )} ${escapeHtml(qr.currency)}</p>
          <p class="orange-qr-merchant">Merchant ${escapeHtml(
            qr.merchantId,
          )}</p>
          ${reference}
        </div>
      </div>
    </section>`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Wallet payment confirmation (webhook listener) ─────────────────────────

export interface OrangePaymentConfirmationPayload {
  /** Transaction id carried in the QR reference. */
  reference?: string;
  transactionId?: string;
  merchantId: string;
  amount: string | number;
  currency?: string;
  status: "success" | "failed" | "pending" | "completed";
  providerTransactionId?: string;
  paidAt?: string;
  [key: string]: unknown;
}

export interface OrangePaymentConfirmationResult {
  accepted: boolean;
  status: string;
  transactionId?: string;
  message: string;
}

export interface OrangeQrPaymentListenerOptions {
  transactionModel?: Pick<TransactionModel, "findById" | "updateStatus">;
  notifyUser?: (result: OrangePaymentConfirmationResult) => void | Promise<void>;
}

/**
 * Listens for Orange Money wallet payment confirmations delivered by webhook
 * and reflects them on the corresponding transaction.
 */
export class OrangeQrPaymentListener {
  private readonly transactionModel: Pick<
    TransactionModel,
    "findById" | "updateStatus"
  >;
  private notifyUser?: (
    result: OrangePaymentConfirmationResult,
  ) => void | Promise<void>;

  constructor(options: OrangeQrPaymentListenerOptions = {}) {
    this.transactionModel = options.transactionModel ?? new TransactionModel();
    this.notifyUser = options.notifyUser;
  }

  setNotificationHandler(
    handler: (result: OrangePaymentConfirmationResult) => void | Promise<void>,
  ): void {
    this.notifyUser = handler;
  }

  async handleConfirmation(
    payload: OrangePaymentConfirmationPayload,
  ): Promise<OrangePaymentConfirmationResult> {
    if (!payload?.merchantId) {
      return {
        accepted: false,
        status: "rejected",
        message: "Missing merchantId",
      };
    }

    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { accepted: false, status: "rejected", message: "Invalid amount" };
    }

    const transactionId = payload.transactionId ?? payload.reference;
    if (!transactionId) {
      return {
        accepted: false,
        status: "rejected",
        message: "Missing transaction reference",
      };
    }

    const transaction = await this.transactionModel.findById(transactionId);
    if (!transaction) {
      return {
        accepted: false,
        status: "not_found",
        transactionId,
        message: "Unknown Orange Money QR transaction",
      };
    }

    const normalizedStatus = payload.status === "completed" ? "success" : payload.status;
    let transactionStatus: TransactionStatus | null = null;
    if (normalizedStatus === "success") transactionStatus = TransactionStatus.Completed;
    else if (normalizedStatus === "failed") transactionStatus = TransactionStatus.Failed;

    if (transactionStatus) {
      await this.transactionModel.updateStatus(
        transactionId,
        transactionStatus,
        transaction.userId ?? undefined,
      );
    }

    const result: OrangePaymentConfirmationResult = {
      accepted: true,
      status: normalizedStatus,
      transactionId,
      message:
        normalizedStatus === "success"
          ? "Orange Money payment confirmed"
          : `Orange Money payment ${normalizedStatus}`,
    };

    logger.info(
      {
        transactionId,
        merchantId: payload.merchantId,
        providerTransactionId: payload.providerTransactionId,
        status: normalizedStatus,
      },
      "[OrangeQr] Wallet payment confirmation received",
    );

    if (this.notifyUser) {
      try {
        await this.notifyUser(result);
      } catch (error) {
        logger.error(
          { error, transactionId },
          "[OrangeQr] Failed to notify user of payment confirmation",
        );
      }
    }

    return result;
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export interface OrangeQrRouterOptions {
  generator?: OrangeQrCodeGenerator;
  listener?: OrangeQrPaymentListener;
}

/**
 * Express router for Orange Money QR generation and wallet callbacks.
 * Mount at `/api/orange/qr`.
 */
export function createOrangeQrRouter(
  options: OrangeQrRouterOptions = {},
): Router {
  const generator = options.generator ?? new OrangeQrCodeGenerator();
  const listener = options.listener ?? new OrangeQrPaymentListener();
  const router = Router();

  router.get("/payload", (req: Request, res: Response) => {
    try {
      const payload = generator.buildPayload({
        merchantId: String(req.query.merchant_id ?? ""),
        amount: String(req.query.amount ?? ""),
        currency: req.query.currency ? String(req.query.currency) : undefined,
        reference: req.query.reference ? String(req.query.reference) : undefined,
        merchantName: req.query.merchant_name
          ? String(req.query.merchant_name)
          : undefined,
      });
      return res.json({ payload });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get("/image", async (req: Request, res: Response) => {
    try {
      const qr = await generator.generate({
        merchantId: String(req.query.merchant_id ?? ""),
        amount: String(req.query.amount ?? ""),
        currency: req.query.currency ? String(req.query.currency) : undefined,
        reference: req.query.reference ? String(req.query.reference) : undefined,
        merchantName: req.query.merchant_name
          ? String(req.query.merchant_name)
          : undefined,
      });
      const buffer = await generator.generateBuffer(qr.payload);
      res.setHeader("Content-Type", "image/png");
      return res.send(buffer);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/webhook", async (req: Request, res: Response) => {
    const result = await listener.handleConfirmation(req.body);
    const status = result.accepted ? 200 : 400;
    return res.status(status).json(result);
  });

  return router;
}

export const orangeQrCodeGenerator = new OrangeQrCodeGenerator();
