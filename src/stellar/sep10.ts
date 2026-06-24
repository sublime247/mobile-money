import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import * as StellarSdk from "stellar-sdk";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/**
 * SEP-10: Stellar Authentication
 * 
 * This implements Stellar Ecosystem Proposal 10 (SEP-10) standard for
 * authentication using Stellar accounts.
 * 
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface Sep10ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

export interface Sep10TokenResponse {
  token: string;
}

export interface Sep10ChallengeParams {
  account: string;
  home_domain?: string;
  client_domain?: string;
  memo?: string;
}

export interface Sep10VerifyParams {
  transaction: string;
}

export interface SignerInfo {
  publicKey: string;
  weight: number;
}

export interface AccountThresholds {
  lowThreshold: number;
  mediumThreshold: number;
  highThreshold: number;
}

// ============================================================================
// Configuration
// ============================================================================

export interface Sep10Config {
  signingKey: string;
  webAuthDomain: string;
  networkPassphrase: string;
  jwtSecret: string;
  challengeExpiresIn: number;
  jwtExpiresIn: string;
  homeDomain: string;
}

export function getSep10Config(): Sep10Config {
  const signingKey = process.env.STELLAR_SIGNING_KEY || process.env.STELLAR_ISSUER_SECRET;
  if (!signingKey) {
    throw new Error("STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET must be defined");
  }

  // Validate the signing key format
  try {
    StellarSdk.Keypair.fromSecret(signingKey);
  } catch (error) {
    throw new Error("Invalid STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET format");
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET must be defined for SEP-10 authentication");
  }

  return {
    signingKey,
    webAuthDomain: process.env.WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
    networkPassphrase: getNetworkPassphrase(),
    jwtSecret,
    challengeExpiresIn: 900, // 15 minutes
    jwtExpiresIn: "1h",
    homeDomain: process.env.STELLAR_HOME_DOMAIN || "api.mobilemoney.com",
  };
}

// ============================================================================
// SEP-10 Service
// ============================================================================

export class Sep10Service {
  protected config: Sep10Config;
  private serverKeypair: StellarSdk.Keypair;
  private stellarServer: StellarSdk.Horizon.Server | null;

  constructor(config: Sep10Config, stellarServer?: StellarSdk.Horizon.Server) {
    this.config = config;
    this.serverKeypair = StellarSdk.Keypair.fromSecret(config.signingKey);
    this.stellarServer = stellarServer || null;
  }

  /**
   * Get the Stellar server instance, initializing if not provided
   */
  private getStellarServer(): StellarSdk.Horizon.Server {
    if (!this.stellarServer) {
      this.stellarServer = getStellarServer();
    }
    return this.stellarServer;
  }

  static isValidPublicKey(publicKey: string): boolean {
    try {
      return StellarSdk.StrKey.isValidEd25519PublicKey(publicKey);
    } catch {
      return false;
    }
  }

  getServerPublicKey(): string {
    return this.serverKeypair.publicKey();
  }

  /**
   * Fetch account signers from the Horizon API
   * 
   * @param accountId - The Stellar account ID
   * @returns Object containing signers and thresholds
   */
  async fetchAccountSigners(accountId: string): Promise<{
    signers: SignerInfo[];
    thresholds: AccountThresholds;
    masterWeight: number;
  }> {
    try {
      const server = this.getStellarServer();
      const account = await server.loadAccount(accountId);

      // Get master key weight
      const masterWeight = (account as any).thresholds?.master_weight ?? 1;

      // Extract all signers
      const signers: SignerInfo[] = [];

      // Add master key as a signer
      if (masterWeight > 0) {
        signers.push({
          publicKey: accountId,
          weight: masterWeight,
        });
      }

      // Add other signers
      if ((account as any).signers) {
        for (const signer of (account as any).signers) {
          if (signer.type === "ed25519_public_key") {
            signers.push({
              publicKey: signer.key,
              weight: signer.weight,
            });
          }
        }
      }

      const thresholds: AccountThresholds = {
        lowThreshold: (account as any).thresholds?.low_threshold ?? 0,
        mediumThreshold: (account as any).thresholds?.med_threshold ?? 0,
        highThreshold: (account as any).thresholds?.high_threshold ?? 0,
      };

      return { signers, thresholds, masterWeight };
    } catch (error) {
      logger.error(`[SEP-10] Failed to fetch account signers for ${accountId}:`, error);
      throw new Error(`Unable to fetch account information from Horizon: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Calculate the total weight of valid signatures on a transaction
   * Excludes the server signature
   * 
   * @param transaction - The transaction to analyze
   * @param signers - The list of valid signers with their weights
   * @param serverPublicKey - The server's public key (to exclude from weight calculation)
   * @returns The total weight of client signatures
   */
  calculateSignatureWeights(
    transaction: StellarSdk.Transaction,
    signers: SignerInfo[],
    serverPublicKey: string
  ): number {
    const txHash = transaction.hash();
    let totalWeight = 0;

    // Track which signers we've already counted (to avoid double-counting)
    const validatedSigners = new Set<string>();

    // Check each signature in the transaction
    for (const sig of transaction.signatures) {
      const signatureBuffer = sig.signature();

      // Try to verify this signature against each signer
      for (const signer of signers) {
        // Skip the server's public key - it's already verified separately
        if (signer.publicKey === serverPublicKey) {
          continue;
        }

        // Skip if we already counted this signer
        if (validatedSigners.has(signer.publicKey)) {
          continue;
        }

        try {
          const keypair = StellarSdk.Keypair.fromPublicKey(signer.publicKey);
          if (keypair.verify(txHash, signatureBuffer)) {
            totalWeight += signer.weight;
            validatedSigners.add(signer.publicKey);
            break; // Move to next signature
          }
        } catch {
          // This signer didn't produce this signature, continue to next signer
          continue;
        }
      }
    }

    return totalWeight;
  }

  /**
   * Verify that signature weights meet the account's medium threshold
   * 
   * @param clientAccountId - The client's account ID
   * @returns true if threshold is met
   */
  async verifyThresholdMet(
    transaction: StellarSdk.Transaction,
    clientAccountId: string
  ): Promise<boolean> {
    const { signers, thresholds, masterWeight } = await this.fetchAccountSigners(clientAccountId);

    // If medium threshold is 0, no signatures required (master key always authorized)
    if (thresholds.mediumThreshold === 0) {
      return true;
    }

    // Calculate total weight of valid client signatures (excluding server signature)
    const clientSignatureWeight = this.calculateSignatureWeights(
      transaction,
      signers,
      this.serverKeypair.publicKey()
    );

    console.log(
      `[SEP-10] Account: ${clientAccountId}, ` +
      `Required weight: ${thresholds.mediumThreshold}, ` +
      `Actual weight: ${clientSignatureWeight}`
    );

    return clientSignatureWeight >= thresholds.mediumThreshold;
  }

  /**
   * Generate a challenge transaction for SEP-10 authentication
   * 
   * @param clientPublicKey - The client's Stellar public key
   * @param homeDomain - Optional home domain (defaults to config)
   * @returns Challenge response with transaction XDR and network passphrase
   */
  generateChallenge(clientPublicKey: string, homeDomain?: string): Sep10ChallengeResponse {
    // Validate account address
    if (!Sep10Service.isValidPublicKey(clientPublicKey)) {
      throw new Error("Invalid Stellar public key");
    }

    const domain = homeDomain || this.config.homeDomain;
    const now = Math.floor(Date.now() / 1000);
    const timebounds = {
      minTime: String(now),
      maxTime: String(now + this.config.challengeExpiresIn),
    };

    // Create a source account with sequence number 0
    const sourceAccount = new StellarSdk.Account(clientPublicKey, "-1");

    // Generate random nonce
    const nonce = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) {
      nonce[i] = Math.floor(Math.random() * 256);
    }

    // Build the transaction
    let builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: this.config.networkPassphrase,
      timebounds,
    });

    // Add memo
    const memoBytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      memoBytes[i] = Math.floor(Math.random() * 256);
    }
    builder = builder.addMemo(new StellarSdk.Memo(StellarSdk.MemoHash, memoBytes));

    // Add manageData operation for client
    builder = builder.addOperation(
      StellarSdk.Operation.manageData({
        name: `${domain} auth`,
        value: nonce,
        source: clientPublicKey,
      })
    );

    // Add web_auth_domain operation from server
    builder = builder.addOperation(
      StellarSdk.Operation.manageData({
        name: "web_auth_domain",
        value: this.config.webAuthDomain,
        source: this.serverKeypair.publicKey(),
      })
    );

    const transaction = builder.build();
    transaction.sign(this.serverKeypair);

    return {
      transaction: transaction.toXDR(),
      network_passphrase: this.config.networkPassphrase,
    };
  }

  /**
   * Verify a signed challenge transaction and issue a JWT token
   * Supports both single-signature and multi-signature accounts
   * 
   * @param transactionXDR - The signed transaction XDR
   * @param clientAccountID - Optional client account ID for validation
   * @returns JWT token response
   */
  async verifyChallenge(transactionXDR: string, clientAccountID?: string): Promise<Sep10TokenResponse> {
    // Parse the transaction from XDR
    let transaction: StellarSdk.Transaction;
    try {
      transaction = StellarSdk.TransactionBuilder.fromXDR(
        transactionXDR,
        this.config.networkPassphrase
      ) as StellarSdk.Transaction;
    } catch (error) {
      throw new Error("Invalid transaction envelope");
    }

    // Verify sequence number is 0
    if (transaction.sequence !== "0") {
      throw new Error("Transaction sequence number must be 0");
    }

    // Verify timebounds
    const timeBounds = transaction.timeBounds;
    if (!timeBounds) {
      throw new Error("Transaction must have timebounds");
    }

    const now = Math.floor(Date.now() / 1000);
    const minTime = parseInt(timeBounds.minTime, 10);
    const maxTime = parseInt(timeBounds.maxTime, 10);

    if (now < minTime) {
      throw new Error("Transaction is not yet valid");
    }

    if (now > maxTime) {
      throw new Error("Transaction has expired");
    }

    // Verify all operations are manageData
    if (!transaction.operations.every(op => op.type === "manageData")) {
      throw new Error("Transaction must contain only manageData operations");
    }

    // Extract client public key from first operation
    const firstOp = transaction.operations[0];
    const clientPublicKey = firstOp.source || transaction.source;

    if (clientAccountID && clientPublicKey !== clientAccountID) {
      throw new Error("First manageData operation source must match client account");
    }

    // Verify server signature (always required for SEP-10)
    const txHash = transaction.hash();
    const serverSigned = transaction.signatures.some(sig => {
      try {
        return this.serverKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!serverSigned) {
      throw new Error("Transaction is not signed by the server");
    }

    // Verify that signatures meet the account's threshold (supports multi-signature)
    try {
      const thresholdMet = await this.verifyThresholdMet(transaction, clientPublicKey);
      if (!thresholdMet) {
        throw new Error(
          "Signing threshold not met. The account requires additional signatures to authorize this transaction."
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Signing threshold")) {
        throw error; // Re-throw threshold errors as-is
      }
      // For other errors (e.g., account not found), throw with context
      throw new Error(`Failed to verify signing threshold: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Issue a JWT token
    return this.issueToken(clientPublicKey);
  }

  /**
   * Issue a JWT token for the authenticated client
   * 
   * @param clientPublicKey - The Stellar public key of the authenticated client
   * @returns JWT token response
   */
  issueToken(clientPublicKey: string): Sep10TokenResponse {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600; // 1 hour from now

    const payload = {
      sub: clientPublicKey,
      iss: this.config.webAuthDomain,
      iat,
      exp,
      jti: uuidv4(),
      home_domain: this.config.homeDomain,
    };

    const token = jwt.sign(payload, this.config.jwtSecret, { algorithm: "HS256" });

    return { token };
  }

  /**
   * Verify a JWT token issued by SEP-10
   * 
   * @param token - JWT token to verify
   * @returns Decoded token payload
   */
  verifyToken(token: string): jwt.JwtPayload {
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret, { algorithms: ["HS256"] });
      return decoded as jwt.JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error("Token has expired");
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new Error("Invalid token");
      } else {
        throw new Error("Invalid token");
      }
    }
  }
}

// ============================================================================
// SEP-10 Router
// ============================================================================

export function createSep10Router(service?: Sep10Service): Router {
  const router = Router();
  
  // Only create service if not provided and config is valid
  let sep10Service: Sep10Service | null = service || null;
  
  if (!sep10Service) {
    try {
      sep10Service = new Sep10Service(getSep10Config());
    } catch (error) {
      console.warn("[SEP-10] Failed to initialize SEP-10 service:", error);
      // Service will be null, routes will return 503
    }
  }

  /**
   * GET /
   * 
   * SEP-10 challenge endpoint
   * Returns a challenge transaction for the client to sign
   */
  router.get("/", (req: Request, res: Response) => {
    if (!sep10Service) {
      throw createError(ERROR_CODES.SERVICE_UNAVAILABLE, "SEP-10 service not configured", {
        error: "SEP-10 service not configured",
      });
    }

    try {
      const { account, home_domain } = req.query;

      // Validate required parameters
      if (!account || typeof account !== "string") {
        throw createError(ERROR_CODES.INVALID_INPUT, "account parameter is required", {
          error: "account parameter is required",
        });
      }

      // Generate the challenge transaction
      const challenge = sep10Service.generateChallenge(
        account,
        home_domain as string | undefined
      );

      return res.json(challenge);
    } catch (error) {
      logger.error("[SEP-10] Error generating challenge:", error);
      
      if (error instanceof Error) {
        throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
          error: error.message,
        });
      }

      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to generate challenge transaction");
    }
  });

  /**
   * POST /
   * 
   * SEP-10 verification endpoint
   * Verifies the signed challenge transaction and issues a JWT token
   */
  router.post("/", async (req: Request, res: Response) => {
    if (!sep10Service) {
      throw createError(ERROR_CODES.SERVICE_UNAVAILABLE, "SEP-10 service not configured", {
        error: "SEP-10 service not configured",
      });
    }

    try {
      const { transaction } = req.body;

      // Validate required parameters
      if (!transaction || typeof transaction !== "string") {
        throw createError(ERROR_CODES.INVALID_INPUT, "transaction parameter is required", {
          error: "transaction parameter is required",
        });
      }

      // Verify the challenge and issue a token
      const tokenResponse = await sep10Service.verifyChallenge(transaction);

      return res.json(tokenResponse);
    } catch (error) {
      logger.error("[SEP-10] Error verifying challenge:", error);
      
      if (error instanceof Error) {
        throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
          error: error.message,
        });
      }

      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to verify challenge transaction");
    }
  });

  /**
   * GET /health
   * 
   * Health check endpoint
   */
  router.get("/health", (req: Request, res: Response) => {
    if (!sep10Service) {
      throw createError(ERROR_CODES.SERVICE_UNAVAILABLE, "SEP-10 service not configured", {
        status: "unavailable",
        service: "SEP-10 Authentication",
        error: "Service not configured",
      });
    }

    return res.json({
      status: "ok",
      service: "SEP-10 Authentication",
      server_key: sep10Service.getServerPublicKey(),
    });
  });

  return router;
}
