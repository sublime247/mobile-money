/**
 * KYC provider webhook callback handler.
 *
 * External KYC providers call this endpoint when an asynchronous
 * verification completes. The handler:
 *   1. Authenticates the request via a shared bearer token or
 *      shared secret in `x-kyc-webhook-secret`.
 *   2. Maps the provider status to an internal value
 *      (VERIFIED → "approved", REJECTED → "rejected",
 *       NEEDS_MORE_INFO → "review").
 *   3. Persists the new status to `kyc_applicants`.
 *   4. Emits a `kyc.status_updated` event so SEP-12 GET /customer
 *      reflects the new tier on the next request.
 *   5. Guards duplicate deliveries by checking whether the status
 *      already matches what is stored.
 */

import { Request, Response } from "express";
import { Pool } from "pg";
import { z } from "zod";
import logger from "../utils/logger";
import {
  emitKycStatusUpdated,
} from "../services/kycStatusEvents";

// ─── Status mapping ───────────────────────────────────────────────────────────

/** Status values sent by the external KYC provider. */
export type ProviderKycStatus =
  | "VERIFIED"
  | "REJECTED"
  | "NEEDS_MORE_INFO";

/** Internal verification_status values stored on kyc_applicants. */
export type InternalVerificationStatus = "approved" | "rejected" | "review";

export function mapProviderStatus(
  status: ProviderKycStatus,
): InternalVerificationStatus {
  switch (status) {
    case "VERIFIED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "NEEDS_MORE_INFO":
      return "review";
  }
}

// ─── Payload schema ───────────────────────────────────────────────────────────

const KycWebhookPayloadSchema = z.object({
  /** KYC provider's reference for this check. */
  check_id: z.string().min(1),
  /** Provider's customer / applicant identifier. */
  applicant_id: z.string().min(1),
  /** New verification outcome. */
  status: z.enum(["VERIFIED", "REJECTED", "NEEDS_MORE_INFO"]),
  /** Human-readable explanation, relevant mainly for REJECTED/NEEDS_MORE_INFO. */
  reason: z.string().optional(),
  /** ISO-8601 timestamp from the provider, used for idempotency logging. */
  event_time: z.string().optional(),
});

export type KycWebhookPayload = z.infer<typeof KycWebhookPayloadSchema>;

// ─── Authentication helpers ───────────────────────────────────────────────────

/**
 * Authenticates the inbound webhook request.
 * Accepts either:
 *   - `Authorization: Bearer <KYC_WEBHOOK_SECRET>` (preferred)
 *   - `x-kyc-webhook-secret: <KYC_WEBHOOK_SECRET>` (legacy fallback)
 *
 * Returns `true` when at least one of the above matches the env secret.
 */
export function authenticateKycWebhook(req: Request): boolean {
  const secret = process.env.KYC_WEBHOOK_SECRET;
  if (!secret) return false;

  // Bearer token
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    return token === secret;
  }

  // Shared-secret header
  const secretHeader = req.headers["x-kyc-webhook-secret"];
  if (typeof secretHeader === "string") {
    return secretHeader === secret;
  }

  return false;
}

// ─── Controller ───────────────────────────────────────────────────────────────

export class KycWebhookController {
  private db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  /**
   * POST /kyc/webhook/callback
   *
   * Receives and processes an asynchronous KYC verification result.
   */
  handleCallback = async (req: Request, res: Response): Promise<void> => {
    // 1. Authenticate
    if (!authenticateKycWebhook(req)) {
      logger.warn(
        { path: req.path },
        "[kyc-webhook] Unauthenticated callback rejected",
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // 2. Validate payload
    const parseResult = KycWebhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn(
        { errors: parseResult.error.flatten() },
        "[kyc-webhook] Invalid payload",
      );
      res.status(400).json({
        error: "Invalid payload",
        details: parseResult.error.flatten(),
      });
      return;
    }

    const payload = parseResult.data;
    const internalStatus = mapProviderStatus(payload.status);

    try {
      // 3. Load current row to detect duplicates and read user linkage
      const existing = await this.db.query<{
        user_id: string | null;
        verification_status: string | null;
      }>(
        `SELECT user_id, verification_status
           FROM kyc_applicants
          WHERE applicant_id = $1
          LIMIT 1`,
        [payload.applicant_id],
      );

      if (existing.rows.length === 0) {
        logger.warn(
          { applicantId: payload.applicant_id },
          "[kyc-webhook] No applicant found for provided applicant_id",
        );
        // Ack with 200 so the provider does not keep retrying for an
        // applicant that doesn't exist on our side.
        res.status(200).json({ received: true, outcome: "unknown_applicant" });
        return;
      }

      const row = existing.rows[0];
      const previousStatus = row.verification_status ?? null;

      // 4. Idempotency: skip update when status is already the target value
      if (previousStatus === internalStatus) {
        logger.info(
          {
            applicantId: payload.applicant_id,
            status: internalStatus,
            checkId: payload.check_id,
          },
          "[kyc-webhook] Duplicate delivery — status unchanged, acking without reprocessing",
        );
        res.status(200).json({ received: true, outcome: "duplicate" });
        return;
      }

      // 5. Persist new status
      await this.db.query(
        `UPDATE kyc_applicants
            SET verification_status = $1,
                rejection_reason     = $2,
                updated_at           = NOW()
          WHERE applicant_id = $3`,
        [
          internalStatus,
          payload.reason ?? null,
          payload.applicant_id,
        ],
      );

      logger.info(
        {
          applicantId: payload.applicant_id,
          checkId: payload.check_id,
          previousStatus,
          newStatus: internalStatus,
        },
        "[kyc-webhook] Applicant verification status updated",
      );

      // 6. Emit KYC status event so the SEP-12 customer cache is refreshed
      //    and subsequent GET /customer calls return the new tier immediately.
      emitKycStatusUpdated({
        applicantId: payload.applicant_id,
        userId: row.user_id,
        previousStatus,
        status: internalStatus,
        rejectionReason: payload.reason ?? null,
        source: "kyc_webhook",
      });

      res.status(200).json({ received: true, outcome: "processed" });
    } catch (error) {
      logger.error(
        { error, applicantId: payload.applicant_id },
        "[kyc-webhook] Error processing callback",
      );
      res.status(500).json({ error: "Internal server error" });
    }
  };
}
