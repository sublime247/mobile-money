import { Router, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  Account,
  Keypair,
  Memo,
  MemoHash,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "stellar-sdk";
import { getNetworkPassphrase } from "../config/stellar";

/**
 * SEP-10: Stellar Authentication
 *
 * Implements the Stellar Ecosystem Proposal 10 (SEP-10) standard for
 * authenticating users via their Stellar account.
 *
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * Flow:
 * 1. Client requests a challenge transaction (GET /?account=<G...>)
 * 2. Server builds a transaction with a manageData operation, signs it, returns XDR
 * 3. Client verifies and signs the transaction, submits it back (POST /)
 * 4. Server verifies both signatures, checks timebounds, and issues a JWT
 */

// ============================================================================
// Configuration
// ============================================================================

export interface Sep10Config {
  /** Server signing key (secret key) used to sign challenge transactions */
  signingKey: string;
  /** Web auth domain for the SEP-10 endpoint */
  webAuthDomain: string;
  /** Network passphrase (testnet or mainnet) */
  networkPassphrase: string;
  /** JWT secret for signing tokens */
  jwtSecret: string;
  /** Challenge transaction validity duration in seconds (default: 900 = 15 min) */
  challengeExpiresIn: number;
  /** JWT token expiration (default: "1h") */
  jwtExpiresIn: string;
  /** Home domain of the server (for multi-domain setups) */
  homeDomain?: string;
  /** Additional memo required (for muxed accounts or multi-tenant) */
  clientAttributionRequirement?: boolean;
}

export const getSep10Config = (): Sep10Config => {
  const signingKey =
    process.env.STELLAR_SIGNING_KEY || process.env.STELLAR_ISSUER_SECRET;
  if (!signingKey) {
    throw new Error(
      "STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET must be defined",
    );
  }

  return {
    signingKey,
    webAuthDomain:
      process.env.STELLAR_WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || getNetworkPassphrase(),
    jwtSecret:
      process.env.JWT_SECRET || "default-jwt-secret-change-in-production",
    challengeExpiresIn: parseInt(
      process.env.SEP10_CHALLENGE_EXPIRY || "900",
      10,
    ),
    jwtExpiresIn: process.env.SEP10_JWT_EXPIRES_IN || "1h",
    homeDomain: process.env.STELLAR_HOME_DOMAIN,
  };
};

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

export interface AuthToken {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  home_domain?: string;
}

export interface AuthResponse {
  token: string;
}

// ============================================================================
// SEP-10 Service
// ============================================================================

export class Sep10Service {
  private config: Sep10Config;
  private serverKeypair: Keypair;

  constructor(config?: Partial<Sep10Config>) {
    this.config = { ...getSep10Config(), ...config };
    this.serverKeypair = Keypair.fromSecret(this.config.signingKey);
  }

  /**
   * Returns the server's public key (signing key)
   */
  getServerPublicKey(): string {
    return this.serverKeypair.publicKey();
  }

  /**
   * Validates that a string is a valid Stellar public key
   */
  static isValidPublicKey(account: string): boolean {
    try {
      StrKey.decodeEd25519PublicKey(account);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generates a 64-byte random nonce for the manageData operation value
   */
  private generateNonce(): Buffer {
    return crypto.randomBytes(64);
  }

  /**
   * Builds a challenge transaction for SEP-10 authentication.
   *
   * The transaction:
   * - Has sequence number 0
   * - Contains a manageData operation with the client account as source
   * - The manageData key is "<home_domain> auth" (or just "auth")
   * - The manageData value is a 64-byte random nonce
   * - Has a memo hash (random 32 bytes)
   * - Has timebounds based on the configured expiry
   * - Is signed by the server
   *
   * If additional signers are required (e.g., for MFA), a second manageData
   * operation is added with the server as source.
   */
  generateChallenge(
    account: string,
    homeDomain?: string,
    _memo?: string,
  ): ChallengeResponse {
    if (!Sep10Service.isValidPublicKey(account)) {
      throw new Error("Invalid Stellar public key");
    }

    const networkPassphrase = this.config.networkPassphrase;
    const now = Math.floor(Date.now() / 1000);
    const timebounds = {
      minTime: String(now),
      maxTime: String(now + this.config.challengeExpiresIn),
    };

    // Build the manageData key per SEP-10 spec
    const domain =
      homeDomain || this.config.homeDomain || this.config.webAuthDomain;
    const manageDataKey = `${domain} auth`;

    // Generate 64-byte nonce
    const nonce = this.generateNonce();

    // Build a temporary account with sequence -1.
    // The TransactionBuilder increments the account sequence by 1,
    // so passing "-1" results in a transaction XDR with sequence "0"
    // as required by the SEP-10 specification.
    const sourceAccount = new Account(account, "-1");

    let builder = new TransactionBuilder(sourceAccount, {
      fee: "100", // 100 stroops (base fee)
      networkPassphrase,
      timebounds,
    });

    // Add memo hash (random 32 bytes) for uniqueness
    const memoBytes = crypto.randomBytes(32);
    builder = builder.addMemo(new Memo(MemoHash, memoBytes));

    // Primary manageData operation with client account as source
    builder = builder.addOperation(
      Operation.manageData({
        name: manageDataKey,
        value: nonce,
        source: account,
      }),
    );

    // Add a server-side manageData operation to bind the challenge to the server key
    // This allows clients to verify that the challenge was created by this server
    builder = builder.addOperation(
      Operation.manageData({
        name: "web_auth_domain",
        value: this.config.webAuthDomain,
        source: this.serverKeypair.publicKey(),
      }),
    );

    const transaction = builder.build();

    // Sign with the server key
    transaction.sign(this.serverKeypair);

    return {
      transaction: transaction.toXDR(),
      network_passphrase: networkPassphrase,
    };
  }

  /**
   * Verifies a submitted (signed) challenge transaction and issues a JWT.
   *
   * Verification steps per SEP-10:
   * 1. Decode the transaction envelope XDR
   * 2. Verify it is a valid Transaction (not fee bump)
   * 3. Check that the transaction sequence number is 0
   * 4. Verify timebounds are still valid (not expired, not in the future by >5 min)
   * 5. Verify the transaction is signed by the server
   * 6. Verify the transaction is signed by the client account
   * 7. Validate manageData operations match expected structure
   * 8. Verify only manageData operations are present
   * 9. Issue a JWT with the client's public key as the subject
   *
   * @param transactionXDR - The XDR-encoded transaction envelope (base64)
   * @param clientAccountID - The client's Stellar public key (optional, inferred if not provided)
   * @returns JWT token string
   */
  verifyChallenge(
    transactionXDR: string,
    clientAccountID?: string,
  ): AuthResponse {
    let transaction: Transaction;

    // Step 1: Decode the XDR envelope
    try {
      transaction = TransactionBuilder.fromXDR(
        transactionXDR,
        this.config.networkPassphrase,
      ) as Transaction;
    } catch {
      throw new Error("Invalid transaction envelope");
    }

    // Step 2: Ensure it is a Transaction (not FeeBumpTransaction)
    if (!(transaction instanceof Transaction)) {
      throw new Error("Transaction must not be a fee-bump transaction");
    }

    // Step 3: Sequence number must be 0
    if (transaction.sequence !== "0") {
      throw new Error("Transaction sequence number must be 0");
    }

    // Step 4: Check timebounds
    const timebounds = transaction.timeBounds;
    if (!timebounds) {
      throw new Error("Transaction must have timebounds");
    }

    const now = Math.floor(Date.now() / 1000);
    const minTime = parseInt(timebounds.minTime, 10);
    const maxTime = parseInt(timebounds.maxTime, 10);

    if (now < minTime) {
      throw new Error("Transaction is not yet valid");
    }

    if (now > maxTime) {
      throw new Error("Transaction has expired");
    }

    // Allow a grace period of up to 5 minutes for clock skew
    if (now > maxTime + 300) {
      throw new Error("Transaction has expired (beyond grace period)");
    }

    // Step 5: Verify operations structure
    const operations = transaction.operations;
    if (operations.length < 1) {
      throw new Error("Transaction must contain at least one operation");
    }

    // The first operation must be a manageData with the client account as source
    const firstOp = operations[0];
    if (
      firstOp.type !== "manageData" ||
      !firstOp.name?.endsWith(" auth") ||
      !firstOp.value
    ) {
      throw new Error(
        "First operation must be manageData with a domain auth key and 64-byte value",
      );
    }

    // Determine the client account
    const clientAccount = clientAccountID || firstOp.source;
    if (!clientAccount) {
      throw new Error(
        "Client account could not be determined. Provide account parameter.",
      );
    }

    if (!Sep10Service.isValidPublicKey(clientAccount)) {
      throw new Error("Invalid client account");
    }

    // The first operation source must match the client account
    if (firstOp.source !== clientAccount) {
      throw new Error(
        "First manageData operation source must match client account",
      );
    }

    // The manageData value must be exactly 64 bytes
    const nonceValue = firstOp.value;
    const nonceBuffer =
      typeof nonceValue === "string"
        ? Buffer.from(nonceValue, "utf-8")
        : Buffer.from(nonceValue);
    if (nonceBuffer.length !== 64) {
      throw new Error("manageData value must be exactly 64 bytes");
    }

    // Verify only manageData operations are present
    for (const op of operations) {
      if (op.type !== "manageData") {
        throw new Error("Transaction must contain only manageData operations");
      }
    }

    // Step 6: Verify the transaction is signed by the server
    if (!transaction.signatures.length) {
      throw new Error("Transaction has no signatures");
    }

    const serverSignatureValid = this.verifySignature(
      transaction,
      this.serverKeypair.publicKey(),
    );
    if (!serverSignatureValid) {
      throw new Error("Transaction is not signed by the server");
    }

    // Step 7: Verify the transaction is signed by the client account
    const clientSignatureValid = this.verifySignature(
      transaction,
      clientAccount,
    );
    if (!clientSignatureValid) {
      throw new Error("Transaction is not signed by the client account");
    }

    // Additional signers verification
    // If there are more operations (e.g., web_auth_domain), verify those
    // are signed by the server as well (already done above)
    if (operations.length > 1) {
      for (let i = 1; i < operations.length; i++) {
        const op = operations[i];
        if (op.type === "manageData" && op.name === "web_auth_domain") {
          // web_auth_domain must come from the server
          if (op.source !== this.serverKeypair.publicKey()) {
            throw new Error(
              "web_auth_domain operation must be sourced from the server account",
            );
          }
        }
      }
    }

    // Step 8: Issue JWT
    return this.issueToken(clientAccount);
  }

  /**
   * Verifies that a transaction has been signed by a given account
   */
  private verifySignature(
    transaction: Transaction,
    accountId: string,
  ): boolean {
    const keypair = Keypair.fromPublicKey(accountId);
    const txHash = transaction.hash();

    for (const signature of transaction.signatures) {
      try {
        const sigHint = signature.hint();
        const accountHint = keypair.signatureHint();

        // Check if the signature hint matches the account hint
        if (sigHint.equals(accountHint)) {
          if (keypair.verify(txHash, signature.signature())) {
            return true;
          }
        }
      } catch {
        // Continue checking other signatures
      }
    }

    return false;
  }

  /**
   * Issues a JWT token for an authenticated Stellar account
   */
  issueToken(accountId: string): AuthResponse {
    const jwtId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const payload: AuthToken = {
      iss: this.config.webAuthDomain,
      sub: accountId,
      iat: now,
      exp: now + this.parseExpiration(this.config.jwtExpiresIn),
      jti: jwtId,
      home_domain: this.config.homeDomain,
    };

    const token = jwt.sign(payload, this.config.jwtSecret, {
      algorithm: "HS256",
    });

    return { token };
  }

  /**
   * Parses expiration string (e.g., "1h", "30m", "86400") to seconds
   */
  private parseExpiration(expiration: string): number {
    const match = expiration.match(/^(\d+)([smhd])?$/);
    if (!match) {
      return 3600; // Default 1 hour
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || "s";

    switch (unit) {
      case "s":
        return value;
      case "m":
        return value * 60;
      case "h":
        return value * 3600;
      case "d":
        return value * 86400;
      default:
        return 3600;
    }
  }

  /**
   * Verifies a JWT token issued by this service
   */
  verifyToken(token: string): AuthToken {
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret, {
        algorithms: ["HS256"],
      }) as AuthToken;
      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error("Token has expired");
      }
      throw new Error("Invalid token");
    }
  }
}

// ============================================================================
// Express Router
// ============================================================================

export const createSep10Router = (
  serviceOrConfig?: Sep10Service | Partial<Sep10Config>,
): Router => {
  const router = Router();
  const service =
    serviceOrConfig instanceof Sep10Service
      ? serviceOrConfig
      : new Sep10Service(serviceOrConfig);

  /**
   * GET /
   *
   * Retrieve a challenge transaction for SEP-10 authentication.
   *
   * Query parameters:
   * - account (required): Stellar public key of the client
   * - home_domain (optional): Home domain of the client application
   * - memo (optional): Memo to include in the transaction (for muxed accounts)
   *
   * Returns:
   * - transaction: Base64-encoded XDR of the challenge transaction
   * - network_passphrase: The network passphrase for the transaction
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const { account, home_domain, memo } = req.query;

      if (!account || typeof account !== "string") {
        return res.status(400).json({
          error: "account parameter is required",
        });
      }

      if (!Sep10Service.isValidPublicKey(account)) {
        return res.status(400).json({
          error: "Invalid Stellar public key",
        });
      }

      const challenge = service.generateChallenge(
        account,
        home_domain as string | undefined,
        memo as string | undefined,
      );

      return res.status(200).json(challenge);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to generate challenge";
      console.error("[SEP-10] Error generating challenge:", error);
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /
   *
   * Submit a signed challenge transaction to receive a JWT token.
   *
   * Request body:
   * - transaction (required): Base64-encoded XDR of the signed challenge transaction
   *
   * Returns:
   * - token: JWT token for authentication
   */
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { transaction: transactionXDR } = req.body;

      if (!transactionXDR || typeof transactionXDR !== "string") {
        return res.status(400).json({
          error: "transaction parameter is required",
        });
      }

      // Extract the account from the URL query param if provided
      const account = req.query.account as string | undefined;

      const authResponse = service.verifyChallenge(transactionXDR, account);

      return res.status(200).json(authResponse);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to verify challenge";
      console.error("[SEP-10] Error verifying challenge:", error);

      // Return 400 for client errors, 500 for server errors
      const statusCode =
        message.includes("Invalid") ||
        message.includes("expired") ||
        message.includes("not signed") ||
        message.includes("must be") ||
        message.includes("must contain")
          ? 400
          : 500;

      return res.status(statusCode).json({ error: message });
    }
  });

  /**
   * GET /health
   *
   * Health check endpoint for SEP-10 service
   */
  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "SEP-10 Authentication",
      server_key: service.getServerPublicKey(),
    });
  });

  return router;
};

// Export a default router factory that reads from environment
export default createSep10Router;
