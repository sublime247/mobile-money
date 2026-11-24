import { EventEmitter } from "events";
import logger from "../utils/logger";

/**
 * In-process notifications for KYC verification status changes.
 *
 * Kept in its own module (rather than on KYCService) so subscribers such as
 * the SEP-12 partner webhook trigger are unaffected when KYCService is mocked.
 */

export const KYC_STATUS_UPDATED = "kyc.status_updated";

export interface KycStatusUpdatedEvent {
  applicantId: string;
  /** Internal user / SEP-12 customer id, when the applicant is linked. */
  userId: string | null;
  /** Status stored before this update, when known. */
  previousStatus?: string | null;
  status: string;
  kycLevel?: string | null;
  rejectionReason?: string | null;
  source: string;
}

export const kycStatusEvents = new EventEmitter();
// Each SEP-12 router plus ad-hoc subscribers; avoid spurious leak warnings.
kycStatusEvents.setMaxListeners(50);

/**
 * Publish a status update. Listener failures are logged and never propagate
 * into the KYC persistence path.
 */
export function emitKycStatusUpdated(event: KycStatusUpdatedEvent): void {
  try {
    kycStatusEvents.emit(KYC_STATUS_UPDATED, event);
  } catch (error) {
    logger.error(
      {
        applicantId: event.applicantId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[kyc-status-events] Listener failed while handling status update",
    );
  }
}
