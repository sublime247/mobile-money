import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
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
  /**
   * Extra home domains this server issues tokens for, besides `homeDomain`.
   * A challenge request naming any other `home_domain` is rejected.
   */
  additionalHomeDomains?: string[];
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
    additionalHomeDomains: (process.env.STELLAR_ADDITIONAL_HOME_DOMAINS || "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Read raw signature bytes from a decorated signature.
 * SDK 17's XDR `Signature` stringifies to hex; `.value` is the raw bytes.
 */
function readDecoratedSignature(
  sig: StellarSdk.xdr.DecoratedSignature,
): Buffer {
  const signature = sig.signature as unknown;

  if (typeof signature === "function") {
    const raw = (signature as () => unknown).call(sig);
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      return Buffer.from(raw);
    }
  }

  const rendered =
    signature && typeof (signature as { toString?: () => string }).toString === "function"
      ? String(signature)
      : "";
  if (/^[0-9a-f]+$/i.test(rendered) && rendered.length % 2 === 0) {
    return Buffer.from(rendered, "hex");
  }

  const value = (signature as { value?: Uint8Array } | null)?.value;
  if (value && (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    return Buffer.from(value);
  }

  throw new Error("Unreadable signature");
}

// ============================================================================
// Client attribution (client_domain) verification
// ============================================================================

const clientDomainCache = new Map<
  string,
  { signingKey: string; fetchedAt: number }
>();
const CACHE_TTL_MS = 15 * 60 * 1000;
const STELLAR_TOML_FETCH_TIMEOUT_MS = 5000;
/** SEP-1 caps stellar.toml at 100KB. */
const STELLAR_TOML_MAX_BYTES = 100 * 1024;

const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const CLIENT_DOMAIN_PATTERN = new RegExp(
  `^(?:${DOMAIN_LABEL}\\.)+[a-z]{2,63}$`,
);
const LOCAL_DOMAIN_PATTERN = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/** Clear the stellar.toml signing-key cache (used by tests). */
export function clearClientDomainCache(): void {
  clientDomainCache.clear();
}

function isLocalDomain(domain: string): boolean {
  return LOCAL_DOMAIN_PATTERN.test(domain);
}

/**
 * Parse and normalise the `client_domain` challenge parameter.
 *
 * SEP-10 defines it as a bare domain: schemes, paths, query strings,
 * credentials and ports are rejected so the value cannot be used to point the
 * stellar.toml lookup at an arbitrary URL. `localhost` / `127.0.0.1` (with an
 * optional port) are allowed for local development.
 */
export function parseClientDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid client_domain: must be a string");
  }
  const domain = raw.trim().toLowerCase();
  if (!domain || domain.length > 253) {
    throw new Error("Invalid client_domain: must be a valid domain name");
  }
  if (!CLIENT_DOMAIN_PATTERN.test(domain) && !isLocalDomain(domain)) {
    throw new Error(
      `Invalid client_domain: ${JSON.stringify(raw)} is not a valid domain name`,
    );
  }
  return domain;
}

/**
 * Extract the top-level `SIGNING_KEY` from a stellar.toml document.
 *
 * Only the document root is considered: keys inside a table (e.g. a
 * `[[CURRENCIES]]` entry) and commented-out lines are ignored, and the key
 * name is matched case-sensitively as SEP-1 requires. Returns `null` when no
 * valid ed25519 public key is published.
 */
export function parseStellarTomlSigningKey(toml: string): string | null {
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // First table header ends the root table.
    if (line.startsWith("[")) break;

    const match = line.match(
      /^SIGNING_KEY\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/,
    );
    if (!match) continue;

    const value = (match[1] ?? match[2] ?? "").trim();
    return StellarSdk.StrKey.isValidEd25519PublicKey(value) ? value : null;
  }
  return null;
}

/**
 * Resolve the client domain's SEP-10 signing key from its published
 * `https://<client_domain>/.well-known/stellar.toml`.
 */
export async function fetchClientDomainSigningKey(
  clientDomain: string,
  fetchFn?: typeof fetch,
): Promise<string> {
  let normalizedDomain: string;
  try {
    normalizedDomain = parseClientDomain(clientDomain);
  } catch (error: any) {
    throw new Error(`Client domain verification failed: ${error.message}`);
  }

  const cached = clientDomainCache.get(normalizedDomain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.signingKey;
  }

  const protocol = isLocalDomain(normalizedDomain) ? "http" : "https";
  const url = `${protocol}://${normalizedDomain}/.well-known/stellar.toml`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    STELLAR_TOML_FETCH_TIMEOUT_MS,
  );

  try {
    const customFetch = fetchFn || globalThis.fetch;
    const response = await customFetch(url, {
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching stellar.toml`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > STELLAR_TOML_MAX_BYTES) {
      throw new Error("stellar.toml exceeds the 100KB size limit");
    }

    const signingKey = parseStellarTomlSigningKey(text);
    if (!signingKey) {
      throw new Error(
        `No valid SIGNING_KEY found in ${normalizedDomain}/.well-known/stellar.toml`,
      );
    }

    clientDomainCache.set(normalizedDomain, {
      signingKey,
      fetchedAt: Date.now(),
    });
    return signingKey;
  } catch (error: any) {
    logger.warn(
      { clientDomain: normalizedDomain, err: error.message },
      "[SEP-10] Failed to fetch or parse client domain stellar.toml",
    );
    throw new Error(
      `Client domain verification failed: ${error.message || "Unable to fetch SIGNING_KEY"}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check that `transaction` carries a valid signature from `publicKey`.
 */
function isSignedBy(
  transaction: StellarSdk.Transaction,
  publicKey: string,
): boolean {
  const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
  const txHash = Buffer.from(transaction.hash());
  return transaction.signatures.some((sig) => {
    try {
      return keypair.verify(txHash, readDecoratedSignature(sig));
    } catch {
      return false;
    }
  });
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

  /** Home domains this server will issue challenges and tokens for. */
  getAllowedHomeDomains(): string[] {
    return [
      this.config.homeDomain,
      ...(this.config.additionalHomeDomains || []),
    ].map((d) => d.trim().toLowerCase());
  }

  /**
   * Resolve the `home_domain` challenge parameter against the configured
   * HOME_DOMAIN(s). Defaults to the primary home domain when omitted.
   */
  resolveHomeDomain(homeDomain?: string): string {
    if (homeDomain === undefined || homeDomain === "") {
      return this.config.homeDomain;
    }
    const normalized = homeDomain.trim().toLowerCase();
    if (!this.getAllowedHomeDomains().includes(normalized)) {
      throw new Error(
        `Invalid home_domain: ${homeDomain} is not served by this server`,
      );
    }
    return normalized;
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
      const thresholdsRaw = (account as any).thresholds ?? {};
      const rawSigners = Array.isArray((account as any).signers)
        ? (account as any).signers
        : [];

      // Horizon's signers array is the source of truth. It already includes the
      // master key. `thresholds.master_weight` is not part of the Horizon
      // response, so defaulting it to 1 counts a disabled master key.
      const signers: SignerInfo[] = [];
      const seen = new Set<string>();

      for (const signer of rawSigners) {
        const signerType = signer.type as string | undefined;
        if (signerType && signerType !== "ed25519_public_key") {
          continue;
        }

        const publicKey = String(signer.key || "");
        const weight = Number(signer.weight ?? 0);
        if (
          !publicKey ||
          !Sep10Service.isValidPublicKey(publicKey) ||
          !Number.isFinite(weight) ||
          weight <= 0 ||
          seen.has(publicKey)
        ) {
          continue;
        }

        seen.add(publicKey);
        signers.push({ publicKey, weight });
      }

      const explicitMasterWeight = Number(thresholdsRaw.master_weight);
      if (
        !seen.has(accountId) &&
        Number.isFinite(explicitMasterWeight) &&
        explicitMasterWeight > 0
      ) {
        signers.push({
          publicKey: accountId,
          weight: explicitMasterWeight,
        });
        seen.add(accountId);
      }

      const masterWeight = seen.has(accountId)
        ? (signers.find((signer) => signer.publicKey === accountId)?.weight ??
          0)
        : 0;

      const thresholds: AccountThresholds = {
        lowThreshold: Number(thresholdsRaw.low_threshold ?? 0),
        mediumThreshold: Number(thresholdsRaw.med_threshold ?? 0),
        highThreshold: Number(thresholdsRaw.high_threshold ?? 0),
      };

      return { signers, thresholds, masterWeight };
    } catch (error) {
      logger.error(
        `[SEP-10] Failed to fetch account signers for ${accountId}:`,
        error,
      );
      throw new Error(
        `Unable to fetch account information from Horizon: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    serverPublicKey: string,
  ): number {
    const txHash = transaction.hash();
    let totalWeight = 0;

    // Track which signers we've already counted (to avoid double-counting)
    const validatedSigners = new Set<string>();

    // Check each signature in the transaction
    for (const sig of transaction.signatures) {
      let signatureBuffer: Buffer;
      try {
        signatureBuffer = readDecoratedSignature(sig);
      } catch {
        continue;
      }

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
    clientAccountId: string,
  ): Promise<boolean> {
    const { signers, thresholds, masterWeight } =
      await this.fetchAccountSigners(clientAccountId);

    // If medium threshold is 0, no signatures required (master key always authorized)
    if (thresholds.mediumThreshold === 0) {
      return true;
    }

    // Calculate total weight of valid client signatures (excluding server signature)
    const clientSignatureWeight = this.calculateSignatureWeights(
      transaction,
      signers,
      this.serverKeypair.publicKey(),
    );

    logger.info(
      {
        account: clientAccountId,
        requiredWeight: thresholds.mediumThreshold,
        actualWeight: clientSignatureWeight,
        masterWeight,
      },
      "[SEP-10] Evaluated multisig signer weights",
    );

    return clientSignatureWeight >= thresholds.mediumThreshold;
  }

  /**
   * Generate a challenge transaction for SEP-10 authentication
   *
   * @param clientPublicKey - The client's Stellar public key
   * @param homeDomain - Optional home domain (defaults to config)
   * @param clientDomain - Optional client domain to verify against stellar.toml (#1946)
   * @returns Challenge response with transaction XDR and network passphrase
   */
  async generateChallenge(
    clientPublicKey: string,
    homeDomain?: string,
    clientDomain?: string,
    fetchFn?: typeof fetch,
  ): Promise<Sep10ChallengeResponse> {
    // Validate account address
    if (!Sep10Service.isValidPublicKey(clientPublicKey)) {
      throw new Error("Invalid Stellar public key");
    }

    const domain = this.resolveHomeDomain(homeDomain);

    // Client attribution: resolve the client domain's published SIGNING_KEY
    // from its stellar.toml before issuing a challenge (#1946, #2426).
    let normalizedClientDomain: string | null = null;
    let clientDomainSigningKey: string | null = null;
    if (clientDomain !== undefined && clientDomain !== "") {
      normalizedClientDomain = parseClientDomain(clientDomain);
      clientDomainSigningKey = await fetchClientDomainSigningKey(
        normalizedClientDomain,
        fetchFn,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    // v16+ rejects inverted timebounds (minTime > maxTime) at build time, so a
    // non-positive expiry yields valid bounds whose maxTime is already in the past
    // (challenges are then rejected as expired during verification).
    const timebounds =
      this.config.challengeExpiresIn < 0
        ? {
            minTime: String(now + this.config.challengeExpiresIn - 60),
            maxTime: String(now + this.config.challengeExpiresIn),
          }
        : {
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

    // Add client_domain operation if requested. Per SEP-10 its source is the
    // client domain's SIGNING_KEY, which must also sign the challenge.
    if (normalizedClientDomain && clientDomainSigningKey) {
      builder = builder.addOperation(
        StellarSdk.Operation.manageData({
          name: "client_domain",
          value: normalizedClientDomain,
          source: clientDomainSigningKey,
        }),
      );
    }

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
   * Supports both single-signature and multi-signature accounts
   *
   * @param transactionXDR - The signed transaction XDR
   * @param clientAccountID - Optional client account ID for validation
   * @returns JWT token response
   */
  async verifyChallenge(
    transactionXDR: string,
    clientAccountID?: string,
    fetchFn?: typeof fetch,
  ): Promise<Sep10TokenResponse> {
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

    // Verify timebounds (#1942)
    const timeBounds = transaction.timeBounds;
    if (!timeBounds || !timeBounds.minTime || !timeBounds.maxTime) {
      throw new Error("Transaction must have timebounds");
    }

    const now = Math.floor(Date.now() / 1000);
    const minTime = parseInt(timeBounds.minTime, 10);
    const maxTime = parseInt(timeBounds.maxTime, 10);

    if (isNaN(minTime) || isNaN(maxTime) || (maxTime === 0 && minTime === 0)) {
      throw new Error("Invalid challenge timebounds");
    }

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

    // The first operation must be `<home_domain> auth` for a HOME_DOMAIN this
    // server actually serves.
    const firstOpName = String((firstOp as any).name || "");
    const authenticatedHomeDomain = firstOpName.endsWith(" auth")
      ? firstOpName.slice(0, -" auth".length).toLowerCase()
      : "";
    if (!this.getAllowedHomeDomains().includes(authenticatedHomeDomain)) {
      throw new Error("Invalid home domain in challenge transaction");
    }

    // Verify server signature (always required for SEP-10)
    const txHash = transaction.hash();
    const serverSigned = transaction.signatures.some((sig) => {
      try {
        return this.serverKeypair.verify(
          Buffer.from(txHash),
          readDecoratedSignature(sig),
        );
      } catch {
        return false;
      }
    });

    if (!serverSigned) {
      throw new Error("Transaction is not signed by the server");
    }

    // Verify that signatures meet the account's threshold (supports multi-signature)
    try {
      const thresholdMet = await this.verifyThresholdMet(
        transaction,
        clientPublicKey,
      );
      if (!thresholdMet) {
        throw new Error(
          "Signing threshold not met. The account requires additional signatures to authorize this transaction.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Signing threshold")
      ) {
        throw error; // Re-throw threshold errors as-is
      }
      // For other errors (e.g., account not found), throw with context
      throw new Error(
        `Failed to verify signing threshold: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Client attribution: when a client_domain operation is present, its
    // source must be the SIGNING_KEY published in that domain's stellar.toml
    // and the challenge must carry that key's signature (#1946, #2426).
    const clientDomainOps = transaction.operations.filter(
      (op: any) => op.type === "manageData" && op.name === "client_domain",
    ) as any[];
    if (clientDomainOps.length > 1) {
      throw new Error("Challenge must contain at most one client_domain operation");
    }
    const clientDomainOp = clientDomainOps[0];
    if (clientDomainOp) {
      if (!clientDomainOp.value) {
        throw new Error("client_domain operation must have a value");
      }
      const clientDomainStr = parseClientDomain(
        Buffer.from(clientDomainOp.value).toString("utf8"),
      );
      const clientDomainSigningKey = await fetchClientDomainSigningKey(
        clientDomainStr,
        fetchFn,
      );

      if (clientDomainOp.source !== clientDomainSigningKey) {
        throw new Error(
          `client_domain operation source does not match ${clientDomainStr} SIGNING_KEY`,
        );
      }

      if (!isSignedBy(transaction, clientDomainSigningKey)) {
        throw new Error(
          `Transaction is not signed by client domain SIGNING_KEY (${clientDomainSigningKey})`,
        );
      }
    }

    // Issue a JWT token
    return this.issueToken(clientPublicKey, authenticatedHomeDomain);
  }

  /**
   * Issue a JWT token for the authenticated client
   *
   * @param clientPublicKey - The Stellar public key of the authenticated client
   * @returns JWT token response
   */
  issueToken(
    clientPublicKey: string,
    homeDomain: string = this.config.homeDomain,
  ): Sep10TokenResponse {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600; // 1 hour from now

    const payload = {
      sub: clientPublicKey,
      iss: this.config.webAuthDomain,
      iat,
      exp,
      jti: uuidv4(),
      home_domain: homeDomain,
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
  router.get("/", async (req: Request, res: Response) => {
    if (!sep10Service) {
      throw createError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "SEP-10 service not configured",
        {
          error: "SEP-10 service not configured",
        },
      );
    }

    try {
      const { account, home_domain, client_domain } = req.query;

      // Validate required parameters
      if (!account || typeof account !== "string") {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "account parameter is required",
          {
            error: "account parameter is required",
          },
        );
      }

      // Generate the challenge transaction
      const challenge = await sep10Service.generateChallenge(
        account,
        home_domain as string | undefined,
        client_domain as string | undefined,
      );

      return res.json(challenge);
    } catch (error) {
      logger.error("[SEP-10] Error generating challenge:", error);

      if (error instanceof Error) {
        throw createError(ERROR_CODES.INVALID_INPUT, error.message, {
          error: error.message,
        });
      }

      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to generate challenge transaction",
      );
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
      throw createError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "SEP-10 service not configured",
        {
          error: "SEP-10 service not configured",
        },
      );
    }

    try {
      const { transaction } = req.body;

      // Validate required parameters
      if (!transaction || typeof transaction !== "string") {
        throw createError(
          ERROR_CODES.INVALID_INPUT,
          "transaction parameter is required",
          {
            error: "transaction parameter is required",
          },
        );
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

      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to verify challenge transaction",
      );
    }
  });

  /**
   * GET /health
   *
   * Health check endpoint
   */
  router.get("/health", (req: Request, res: Response) => {
    if (!sep10Service) {
      throw createError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "SEP-10 service not configured",
        {
          status: "unavailable",
          service: "SEP-10 Authentication",
          error: "Service not configured",
        },
      );
    }

    return res.json({
      status: "ok",
      service: "SEP-10 Authentication",
      server_key: sep10Service.getServerPublicKey(),
    });
  });

  return router;
}
