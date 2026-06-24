import logger from "../utils/logger";
/**
 * KYC Tier Upgrade Job
 *
 * Schedule: Every hour (configurable via KYC_TIER_UPGRADE_CRON)
 *
 * For each active user who is not yet at the Full KYC tier, checks whether
 * their 24-hour completed transaction volume has reached 80% of their current
 * daily limit. When it has:
 *   1. Creates a pending upgrade request (idempotent — skips if one already exists)
 *   2. Sends an email + push notification prompting the user to upgrade
 */

import {
  findUsersNearLimit,
  createUpgradeRequestIfNeeded,
  notifyUserForUpgrade,
} from "../services/kycTierUpgradeService";

export async function runKycTierUpgradeJob(): Promise<void> {
  console.log("[kyc-tier-upgrade] Starting volume scan");

  let scanned: number;
  let flagged = 0;
  let notified = 0;
  let errors = 0;

  try {
    const usersNearLimit = await findUsersNearLimit();
    scanned = usersNearLimit.length;

    for (const userInfo of usersNearLimit) {
      try {
        const requestId = await createUpgradeRequestIfNeeded(userInfo);

        if (requestId) {
          flagged++;
          await notifyUserForUpgrade(requestId, userInfo);
          notified++;
        }
      } catch (userErr) {
        errors++;
        logger.error(
          `[kyc-tier-upgrade] Error processing user ${userInfo.userId}:`,
          userErr,
        );
        // Continue processing remaining users
      }
    }
  } catch (err) {
    logger.error("[kyc-tier-upgrade] Fatal error during volume scan:", err);
    throw err;
  }

  console.log(
    `[kyc-tier-upgrade] Done — scanned: ${scanned}, flagged: ${flagged}, notified: ${notified}, errors: ${errors}`,
  );
}
