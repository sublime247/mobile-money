import { Router, Request, Response } from "express";
import * as StellarSdk from "stellar-sdk";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";

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
  const signingKey =
    process.env.STELLAR_SIGNING_KEY || process.env.STELLAR_ISSUER_SECRET;
  if (!signingKey) {
    throw new Error(
      "STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET must be defined",
    );
  }

  // Validate the signing key format
  try {
    StellarSdk.Keypair.fromSecret(signingKey);
  } catch (error) {
    throw new Error(
      "Invalid STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET format",
    );
  }

  return {
    signingKey,
    webAuthDomain: process.env.WEB_AUTH_DOMAIN || "https://api.mobilemoney.com",
    networkPassphrase: getNetworkPassphrase(),
    jwtSecret: process.env.JWT_SECRET || "default-jwt-secret",
    challengeExpiresIn: 900, // 15 minutes
    jwtExpiresIn: "1h",
    homeDomain: process.env.STELLAR_HOME_DOMAIN || "api.mobilemoney.com",
  };
}

// ============================================================================
// SEP-10 Service
// ============================================================================

export class Sep10Service {
  private config: Sep10Config;
  private serverKeypair: StellarSdk.Keypair;

  constructor(config: Sep10Config) {
    this.config = config;
    this.serverKeypair = StellarSdk.Keypair.fromSecret(config.signingKey);
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
   * Generate a challenge transaction for SEP-10 authentication
   *
   * @param clientPublicKey - The client's Stellar public key
   * @param homeDomain - Optional home domain (defaults to config)
   * @returns Challenge response with transaction XDR and network passphrase
   */
  generateChallenge(
    clientPublicKey: string,
    homeDomain?: string,
  ): Sep10ChallengeResponse {
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
    builder = builder.addMemo(
      new StellarSdk.Memo(StellarSdk.MemoHash, memoBytes),
    );

    // Add manageData operation for client
    builder = builder.addOperation(
      StellarSdk.Operation.manageData({
        name: `${domain} auth`,
        value: nonce,
        source: clientPublicKey,
      }),
    );

    // Add web_auth_domain operation from server
    builder = builder.addOperation(
      StellarSdk.Operation.manageData({
        name: "web_auth_domain",
        value: this.config.webAuthDomain,
        source: this.serverKeypair.publicKey(),
      }),
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
   *
   * @param transactionXDR - The signed transaction XDR
   * @param clientAccountID - Optional client account ID for validation
   * @returns JWT token response
   */
  verifyChallenge(
    transactionXDR: string,
    clientAccountID?: string,
  ): Sep10TokenResponse {
    // Parse the transaction from XDR
    let transaction: StellarSdk.Transaction;
    try {
      transaction = StellarSdk.TransactionBuilder.fromXDR(
        transactionXDR,
        this.config.networkPassphrase,
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
    if (!transaction.operations.every((op) => op.type === "manageData")) {
      throw new Error("Transaction must contain only manageData operations");
    }

    // Extract client public key from first operation
    const firstOp = transaction.operations[0];
    const clientPublicKey = firstOp.source || transaction.source;

    if (clientAccountID && clientPublicKey !== clientAccountID) {
      throw new Error(
        "First manageData operation source must match client account",
      );
    }

    // Verify server signature
    const txHash = transaction.hash();
    const serverSigned = transaction.signatures.some((sig) => {
      try {
        return this.serverKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!serverSigned) {
      throw new Error("Transaction is not signed by the server");
    }

    // Verify client signature
    const clientKeypair = StellarSdk.Keypair.fromPublicKey(clientPublicKey);
    const clientSigned = transaction.signatures.some((sig) => {
      try {
        return clientKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!clientSigned) {
      throw new Error("Transaction is not signed by the client account");
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

    const token = jwt.sign(payload, this.config.jwtSecret, {
      algorithm: "HS256",
    });

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
      const decoded = jwt.verify(token, this.config.jwtSecret, {
        algorithms: ["HS256"],
      });
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
      return res.status(503).json({
        error: "SEP-10 service not configured",
      });
    }

    try {
      const { account, home_domain } = req.query;

      // Validate required parameters
      if (!account || typeof account !== "string") {
        return res.status(400).json({
          error: "account parameter is required",
        });
      }

      // Generate the challenge transaction
      const challenge = sep10Service.generateChallenge(
        account,
        home_domain as string | undefined,
      );

      return res.json(challenge);
    } catch (error) {
      console.error("[SEP-10] Error generating challenge:", error);

      if (error instanceof Error) {
        return res.status(400).json({
          error: error.message,
        });
      }

      return res.status(500).json({
        error: "Failed to generate challenge transaction",
      });
    }
  });

  /**
   * POST /
   *
   * SEP-10 verification endpoint
   * Verifies the signed challenge transaction and issues a JWT token
   */
  router.post("/", (req: Request, res: Response) => {
    if (!sep10Service) {
      return res.status(503).json({
        error: "SEP-10 service not configured",
      });
    }

    try {
      const { transaction } = req.body;

      // Validate required parameters
      if (!transaction || typeof transaction !== "string") {
        return res.status(400).json({
          error: "transaction parameter is required",
        });
      }

      // Verify the challenge and issue a token
      const tokenResponse = sep10Service.verifyChallenge(transaction);

      return res.json(tokenResponse);
    } catch (error) {
      console.error("[SEP-10] Error verifying challenge:", error);

      if (error instanceof Error) {
        return res.status(400).json({
          error: error.message,
        });
      }

      return res.status(500).json({
        error: "Failed to verify challenge transaction",
      });
    }
  });

  /**
   * GET /health
   *
   * Health check endpoint
   */
  router.get("/health", (req: Request, res: Response) => {
    if (!sep10Service) {
      return res.status(503).json({
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
