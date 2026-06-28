/**
 * Trustline Verification Middleware
 *
 * Verifies that a recipient Stellar account has an active trustline for the
 * configured payment asset (typically USDC) before any withdrawal or transfer
 * is dispatched to the blockchain.
 *
 * Calling Horizon once here — before building and signing a transaction —
 * prevents a wasted base-fee and a failed on-chain execution. A clear 422
 * response guides the API caller to add the trustline first.
 *
 * Usage (Express route):
 *   router.post('/withdraw', verifyTrustline, withdrawController.create);
 *
 * The middleware reads the destination address from:
 *   req.body.destinationAddress  OR  req.body.destination
 *
 * On success it attaches `req.trustlineVerified = true` and calls next().
 * On failure it returns HTTP 422 with a machine-readable error code.
 */

import { Request, Response, NextFunction } from 'express';
import StellarSdk from '@stellar/stellar-sdk';
import { AssetService, getConfiguredPaymentAsset } from '../services/stellar/assetService';
import logger from '../utils/logger';

const assetService = new AssetService();

/**
 * Resolve the raw destination value from the request body.
 * Handles both field names used across the codebase.
 */
function resolveDestination(req: Request): string | undefined {
  const body = req.body as Record<string, unknown>;
  return (body.destinationAddress as string) ?? (body.destination as string) ?? undefined;
}

/**
 * Express middleware — verifies a USDC (or configured asset) trustline exists
 * on the destination account before allowing the request to proceed.
 *
 * Skips the check when:
 *   - The configured payment asset is XLM (native, no trustline needed)
 *   - The destination field is absent (upstream validation will catch it)
 */
export async function verifyTrustline(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const destination = resolveDestination(req);

  // No destination present — let route validation report the missing field
  if (!destination) {
    next();
    return;
  }

  const paymentAsset = getConfiguredPaymentAsset();

  // Native XLM never requires a trustline
  if (paymentAsset.isNative()) {
    next();
    return;
  }

  try {
    const trusted = await assetService.hasTrustline(destination, paymentAsset);

    if (!trusted) {
      const assetCode = paymentAsset.getCode();
      const issuer = paymentAsset.getIssuer();

      logger.warn(
        { destination, assetCode, issuer },
        '[trustline] Recipient missing trustline — blocking withdrawal',
      );

      res.status(422).json({
        error: 'TRUSTLINE_MISSING',
        message:
          `Recipient account ${destination} does not have a trustline for ` +
          `${assetCode}. Ask the recipient to add a trustline before retrying.`,
        details: { assetCode, issuer, destination },
      });
      return;
    }

    // Attach verification flag for downstream handlers / audit logs
    (req as Request & { trustlineVerified: boolean }).trustlineVerified = true;
    next();
  } catch (err) {
    // Horizon unreachable or account not found — fail safe to prevent bad txs
    logger.error(
      { destination, err },
      '[trustline] Trustline check failed — blocking as a precaution',
    );

    res.status(503).json({
      error: 'TRUSTLINE_CHECK_FAILED',
      message:
        'Could not verify recipient trustline. ' +
        'The Stellar network may be temporarily unavailable. Please retry.',
    });
  }
}
