import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { Sep12Service, Sep12CustomerStatus } from "./sep12";
import {
  sanctionService,
  SanctionScreeningError,
} from "../services/sanctionService";
import { getNetworkPassphrase, getStellarServer } from "../config/stellar";

/**
 * SEP-08: Regulated Assets
 *
 * Implements the approval server component of SEP-08, which lets a bridge/anchor
 * gate regulated-asset transactions behind KYC and sanctions checks. Clients submit
 * an unsigned (or partially-signed) transaction XDR; the server validates the
 * submitter, and on success adds the bridge's authorization signature and returns
 * the envelope for the client to submit to Horizon.
 *
 * Specification: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md
 */

// ============================================================================
// Types
// ============================================================================

export type Sep8Status =
  | "success"
  | "revised"
  | "pending"
  | "action_required"
  | "rejected";

export interface Sep8SuccessResponse {
  status: "success" | "revised";
  tx: string;
  message: string;
}

export interface Sep8PendingResponse {
  status: "pending";
  timeout: number;
  message: string;
}

export interface Sep8ActionRequiredResponse {
  status: "action_required";
  message: string;
  action_url: string;
  action_method: "GET" | "POST";
  action_fields: string[];
}

export interface Sep8RejectedResponse {
  status: "rejected";
  error: string;
}

export type Sep8Response =
  | Sep8SuccessResponse
  | Sep8PendingResponse
  | Sep8ActionRequiredResponse
  | Sep8RejectedResponse;

// ============================================================================
// Client-side approval pipeline (#2432)
//
// The router above is the anchor-side /tx_approve server. The types and
// functions below are the CLIENT side: before a regulated asset is submitted
// to Horizon, inspect its authorization flags and obtain an approval decision
// from the asset's SEP-08 approval server. All network access is injectable.
// ============================================================================

/** Base class for failures in the client-side SEP-08 pipeline. */
export class Sep8ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Sep8ClientError";
  }
}

/** Horizon asset/account flag lookup failed — fail closed before submission. */
export class Sep8InspectionError extends Sep8ClientError {
  constructor(message: string) {
    super(message);
    this.name = "Sep8InspectionError";
  }
}

/** No approval server could be resolved for a regulated asset. */
export class Sep8ConfigurationError extends Sep8ClientError {
  constructor(message: string) {
    super(message);
    this.name = "Sep8ConfigurationError";
  }
}

/** Approval server responded with a non-approval status or an invalid payload. */
export class Sep8ApprovalError extends Sep8ClientError {
  constructor(
    message: string,
    public readonly status: Sep8Status,
    public readonly response?: Sep8Response,
  ) {
    super(message);
    this.name = "Sep8ApprovalError";
  }
}

export class Sep8ActionRequiredError extends Sep8ApprovalError {
  readonly actionUrl: string;
  readonly actionMethod: "GET" | "POST";
  readonly actionFields: string[];

  constructor(response: Sep8ActionRequiredResponse) {
    super(
      response.message || "SEP-08 approval requires additional action",
      "action_required",
      response,
    );
    this.name = "Sep8ActionRequiredError";
    this.actionUrl = response.action_url;
    this.actionMethod = response.action_method;
    this.actionFields = response.action_fields;
  }
}

export class Sep8PendingError extends Sep8ApprovalError {
  readonly timeout: number;

  constructor(response: Sep8PendingResponse) {
    super(
      response.message || "SEP-08 approval is pending",
      "pending",
      response,
    );
    this.name = "Sep8PendingError";
    this.timeout = response.timeout;
  }
}

export class Sep8RejectedError extends Sep8ApprovalError {
  constructor(response: Sep8RejectedResponse) {
    super(
      response.error || "Transaction rejected by SEP-08 approval server",
      "rejected",
      response,
    );
    this.name = "Sep8RejectedError";
  }
}

export interface Sep8AssetFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  [key: string]: unknown;
}

export interface Sep8HorizonAssetRecord {
  asset_code?: string;
  asset_issuer?: string;
  flags?: Sep8AssetFlags;
  /** Optional approval-server URL exposed by a custom Horizon deployment. */
  approval_server?: string;
  [key: string]: unknown;
}

export interface Sep8HorizonAccountRecord {
  account_id?: string;
  flags?: Sep8AssetFlags;
  [key: string]: unknown;
}

export interface Sep8HorizonClient {
  loadAsset(
    assetCode: string,
    assetIssuer: string,
  ): Promise<Sep8HorizonAssetRecord>;
  loadAccount(accountId: string): Promise<Sep8HorizonAccountRecord>;
}

export interface Sep8ApprovalClient {
  approve(txXdr: string): Promise<Sep8Response>;
}

export interface Sep8ClientOptions {
  /** Replaces Horizon flag lookups in tests. */
  horizon?: Sep8HorizonClient;
  /** Replaces the HTTP call to the approval server in tests. */
  approval?: Sep8ApprovalClient;
  /** Explicit SEP-08 approval server URL (overrides asset/env discovery). */
  approvalServerUrl?: string;
  networkPassphrase?: string;
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface Sep8ApprovalResult {
  /** True when at least one regulated asset required an approval decision. */
  regulated: boolean;
  status: "success" | "revised" | null;
  /** Envelope to submit (the returned XDR replaces the original on revised). */
  envelope: string;
  response?: Sep8SuccessResponse;
  assetCode?: string;
}

// ============================================================================
// Config
// ============================================================================

export interface Sep8Config {
  signingKey: string;
  networkPassphrase: string;
  kycActionUrl: string;
}

export function getSep8Config(): Sep8Config {
  const signingKey =
    process.env.STELLAR_SIGNING_KEY || process.env.STELLAR_ISSUER_SECRET;
  if (!signingKey) {
    throw new Error(
      "STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET must be defined for SEP-08",
    );
  }

  return {
    signingKey,
    networkPassphrase: getNetworkPassphrase(),
    kycActionUrl:
      process.env.SEP8_KYC_ACTION_URL ||
      `${process.env.STELLAR_TRANSFER_SERVER || "https://api.mobilemoney.com"}/sep12`,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract unique (sender, receiver) address pairs from payment-like operations
 * in the transaction so each can be screened for sanctions.
 */
function extractPaymentPairs(
  transaction: StellarSdk.Transaction,
  sourceAccount: string,
): Array<{ sender: string; receiver: string }> {
  const pairs: Array<{ sender: string; receiver: string }> = [];

  for (const op of transaction.operations) {
    const opSource = (op as any).source ?? sourceAccount;

    if (op.type === "payment") {
      pairs.push({
        sender: opSource,
        receiver: (op as StellarSdk.Operation.Payment).destination,
      });
    } else if (op.type === "pathPaymentStrictSend") {
      pairs.push({
        sender: opSource,
        receiver: (op as StellarSdk.Operation.PathPaymentStrictSend)
          .destination,
      });
    } else if (op.type === "pathPaymentStrictReceive") {
      pairs.push({
        sender: opSource,
        receiver: (op as StellarSdk.Operation.PathPaymentStrictReceive)
          .destination,
      });
    }
  }

  // If the transaction contains no payment operations, screen the source account alone.
  if (pairs.length === 0) {
    pairs.push({ sender: sourceAccount, receiver: sourceAccount });
  }

  return pairs;
}

/**
 * Extracts the distinct non-native assets referenced by an envelope. Fee-bump
 * wrappers are unwrapped so the operations of the inner transaction are used.
 */
export function extractSep8Assets(
  envelope: string,
  networkPassphrase: string,
): StellarSdk.Asset[] {
  const parsed = StellarSdk.TransactionBuilder.fromXDR(
    envelope,
    networkPassphrase,
  );
  const transaction =
    parsed instanceof StellarSdk.FeeBumpTransaction
      ? parsed.innerTransaction
      : parsed;

  const assets = new Map<string, StellarSdk.Asset>();
  for (const operation of transaction.operations as any[]) {
    const candidates = [
      operation.asset,
      operation.line,
      operation.buying,
      operation.selling,
    ];
    for (const candidate of candidates) {
      if (
        candidate &&
        typeof candidate.isNative === "function" &&
        !candidate.isNative() &&
        typeof candidate.getIssuer === "function"
      ) {
        assets.set(`${candidate.getCode()}:${candidate.getIssuer()}`, candidate);
      }
    }
  }

  return [...assets.values()];
}

function hasAuthFlag(flags?: Sep8AssetFlags): boolean {
  return Boolean(flags?.auth_required || flags?.auth_revocable);
}

/** Adapts a Horizon server to the injectable flag-lookup interface. */
export function createSep8HorizonClient(
  server: Pick<StellarSdk.Horizon.Server, "assets" | "loadAccount">,
): Sep8HorizonClient {
  return {
    async loadAsset(assetCode, assetIssuer) {
      const page = await server
        .assets()
        .forCode(assetCode)
        .forIssuer(assetIssuer)
        .call();
      return (page.records[0] ?? {}) as Sep8HorizonAssetRecord;
    },
    async loadAccount(accountId) {
      return (await server.loadAccount(accountId)) as unknown as Sep8HorizonAccountRecord;
    },
  };
}

/** Validates and narrows an approval server JSON response. */
export function parseSep8ApprovalResponse(payload: unknown): Sep8Response {
  if (!payload || typeof payload !== "object") {
    throw new Sep8ApprovalError(
      "SEP-08 approval server returned an invalid response",
      "rejected",
    );
  }

  const body = payload as Record<string, unknown>;
  switch (body.status) {
    case "success":
    case "revised":
      if (typeof body.tx !== "string" || body.tx.trim() === "") {
        throw new Sep8ApprovalError(
          `SEP-08 ${body.status} response is missing the transaction XDR`,
          "rejected",
        );
      }
      return {
        status: body.status,
        tx: body.tx,
        message: typeof body.message === "string" ? body.message : "",
      };
    case "pending":
      if (typeof body.timeout !== "number") {
        throw new Sep8ApprovalError(
          "SEP-08 pending response is missing a numeric timeout",
          "rejected",
        );
      }
      return {
        status: "pending",
        timeout: body.timeout,
        message: typeof body.message === "string" ? body.message : "",
      };
    case "action_required":
      if (
        typeof body.action_url !== "string" ||
        (body.action_method !== "GET" && body.action_method !== "POST") ||
        !Array.isArray(body.action_fields)
      ) {
        throw new Sep8ApprovalError(
          "SEP-08 action_required response is incomplete",
          "rejected",
        );
      }
      return {
        status: "action_required",
        message: typeof body.message === "string" ? body.message : "",
        action_url: body.action_url,
        action_method: body.action_method,
        action_fields: body.action_fields.filter(
          (field): field is string => typeof field === "string",
        ),
      };
    case "rejected":
      return {
        status: "rejected",
        error:
          typeof body.error === "string"
            ? body.error
            : "Transaction rejected by SEP-08 approval server",
      };
    default:
      throw new Sep8ApprovalError(
        `Unknown SEP-08 approval status: ${String(body.status)}`,
        "rejected",
      );
  }
}

/** Default HTTP client for SEP-08 POST /tx_approve (form-encoded `tx`). */
export function createSep8ApprovalClient(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Sep8ApprovalClient {
  return {
    async approve(txXdr) {
      let httpResponse: globalThis.Response;
      try {
        httpResponse = await fetchImpl(serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ tx: txXdr }).toString(),
        });
      } catch (err) {
        throw new Sep8ClientError(
          `SEP-08 approval request failed: ${(err as Error).message}`,
        );
      }

      if (!httpResponse.ok) {
        throw new Sep8ApprovalError(
          `SEP-08 approval server returned HTTP ${httpResponse.status}`,
          "rejected",
        );
      }

      let payload: unknown;
      try {
        payload = await httpResponse.json();
      } catch {
        throw new Sep8ClientError(
          "SEP-08 approval server returned invalid JSON",
        );
      }

      return parseSep8ApprovalResponse(payload);
    },
  };
}

async function findRegulatedAssets(
  assets: StellarSdk.Asset[],
  horizon: Sep8HorizonClient,
): Promise<
  Array<{ asset: StellarSdk.Asset; record: Sep8HorizonAssetRecord }>
> {
  const regulated: Array<{
    asset: StellarSdk.Asset;
    record: Sep8HorizonAssetRecord;
  }> = [];

  for (const asset of assets) {
    const code = asset.getCode();
    const issuer = asset.getIssuer();
    let record: Sep8HorizonAssetRecord;

    try {
      record = await horizon.loadAsset(code, issuer);
    } catch (err) {
      throw new Sep8InspectionError(
        `Unable to inspect Horizon asset ${code}:${issuer}: ${(err as Error).message}`,
      );
    }

    let isRegulated = hasAuthFlag(record.flags);
    if (!isRegulated) {
      try {
        const issuerAccount = await horizon.loadAccount(issuer);
        isRegulated = hasAuthFlag(issuerAccount.flags);
      } catch (err) {
        throw new Sep8InspectionError(
          `Unable to inspect issuer account ${issuer}: ${(err as Error).message}`,
        );
      }
    }

    if (isRegulated) regulated.push({ asset, record });
  }

  return regulated;
}

function resolveApprovalServerUrl(
  regulated: Array<{ asset: StellarSdk.Asset; record: Sep8HorizonAssetRecord }>,
  options: Sep8ClientOptions,
): string {
  const fromAsset = regulated.find(
    ({ record }) => typeof record.approval_server === "string",
  )?.record.approval_server;
  const url =
    options.approvalServerUrl?.trim() ||
    fromAsset?.trim() ||
    process.env.SEP8_APPROVAL_SERVER_URL?.trim();

  if (!url) {
    const assetNames = regulated
      .map(({ asset }) => `${asset.getCode()}:${asset.getIssuer()}`)
      .join(", ");
    throw new Sep8ConfigurationError(
      `Regulated asset(s) require SEP-08 approval but no approval server is configured: ${assetNames}`,
    );
  }

  return url;
}

/**
 * Client-side SEP-08 gate. Returns the envelope to submit (possibly replaced
 * by a revised XDR), or a no-op result when no regulated asset is involved.
 *
 * Any non-approval status throws a typed Sep8*Error, so callers cannot submit
 * a regulated asset without an explicit approval decision.
 */
export async function enforceSep8Approval(
  envelope: string,
  options: Sep8ClientOptions = {},
): Promise<Sep8ApprovalResult> {
  const networkPassphrase =
    options.networkPassphrase ?? getNetworkPassphrase();

  let assets: StellarSdk.Asset[];
  try {
    assets = extractSep8Assets(envelope, networkPassphrase);
  } catch (err) {
    throw new Sep8ClientError(
      `Invalid transaction XDR for SEP-08 inspection: ${(err as Error).message}`,
    );
  }

  if (assets.length === 0) {
    return { regulated: false, status: null, envelope };
  }

  const horizon = options.horizon ?? createSep8HorizonClient(getStellarServer());
  const regulated = await findRegulatedAssets(assets, horizon);
  if (regulated.length === 0) {
    return { regulated: false, status: null, envelope };
  }

  const approval =
    options.approval ??
    createSep8ApprovalClient(
      resolveApprovalServerUrl(regulated, options),
      options.fetch,
    );

  const response = parseSep8ApprovalResponse(await approval.approve(envelope));

  switch (response.status) {
    case "success":
    case "revised": {
      let approvedEnvelope = envelope;
      try {
        // Always use the server-returned XDR: even `success` carries the
        // approval signature, and `revised` may change the transaction.
        StellarSdk.TransactionBuilder.fromXDR(
          response.tx,
          networkPassphrase,
        );
        approvedEnvelope = response.tx;
      } catch (err) {
        throw new Sep8ApprovalError(
          `SEP-08 approval server returned malformed transaction XDR: ${(err as Error).message}`,
          "rejected",
          response,
        );
      }
      return {
        regulated: true,
        status: response.status,
        envelope: approvedEnvelope,
        response,
        assetCode: regulated[0].asset.getCode(),
      };
    }
    case "action_required":
      throw new Sep8ActionRequiredError(response);
    case "pending":
      throw new Sep8PendingError(response);
    case "rejected":
      throw new Sep8RejectedError(response);
  }
}

// ============================================================================
// Router
// ============================================================================

export const createSep8Router = (db: Pool): Router => {
  const sep8Router = Router();
  const sep12Service = new Sep12Service(db);

  /**
   * POST /tx_approve
   *
   * Request body (application/json or application/x-www-form-urlencoded):
   *   tx  - base64-encoded XDR of the transaction to approve
   *
   * Returns one of the five SEP-08 response shapes:
   *   success          - signed transaction ready for submission
   *   revised          - transaction was modified then signed
   *   pending          - awaiting async KYC review
   *   action_required  - client must complete KYC before retrying
   *   rejected         - transaction cannot be approved
   */
  sep8Router.post("/tx_approve", async (req: Request, res: Response) => {
    try {
      const { tx } = req.body as { tx?: string };

      if (!tx) {
        return res.status(400).json({
          status: "rejected",
          error: "Missing required parameter: tx",
        } satisfies Sep8RejectedResponse);
      }

      // Load server config — fail fast if env is misconfigured.
      let config: Sep8Config;
      try {
        config = getSep8Config();
      } catch (err: any) {
        logger.error(err, "[SEP-8] Server configuration error:");
        return res.status(500).json({
          status: "rejected",
          error: "Internal server configuration error",
        } satisfies Sep8RejectedResponse);
      }

      // Parse the transaction XDR.
      let transaction: StellarSdk.Transaction;
      try {
        transaction = new StellarSdk.Transaction(tx, config.networkPassphrase);
      } catch {
        return res.status(400).json({
          status: "rejected",
          error: "Invalid transaction: could not parse XDR",
        } satisfies Sep8RejectedResponse);
      }

      const sourceAccount = transaction.source;

      if (!StellarSdk.StrKey.isValidEd25519PublicKey(sourceAccount)) {
        return res.status(400).json({
          status: "rejected",
          error: "Transaction source is not a valid Stellar public key",
        } satisfies Sep8RejectedResponse);
      }

      // KYC check: the source account must be a verified customer.
      let customer: Awaited<ReturnType<typeof sep12Service.getCustomer>>;
      try {
        customer = await sep12Service.getCustomer(
          sourceAccount,
          undefined,
          undefined,
        );
      } catch (err: any) {
        logger.error(err, "[SEP-8] KYC lookup failed:");
        return res.status(500).json({
          status: "rejected",
          error: "Internal server error during KYC check",
        } satisfies Sep8RejectedResponse);
      }

      if (
        customer.status === Sep12CustomerStatus.NEEDS_INFO ||
        customer.status === Sep12CustomerStatus.REJECTED
      ) {
        return res.json({
          status: "action_required",
          message:
            "Complete KYC verification before transacting with this regulated asset.",
          action_url: config.kycActionUrl,
          action_method: "GET",
          action_fields: [
            "first_name",
            "last_name",
            "email_address",
            "id_type",
            "id_number",
          ],
        } satisfies Sep8ActionRequiredResponse);
      }

      if (customer.status === Sep12CustomerStatus.PROCESSING) {
        return res.json({
          status: "pending",
          timeout: 3600,
          message:
            "Your KYC verification is under review. Please try again later.",
        } satisfies Sep8PendingResponse);
      }

      // Sanctions screening: check source and all payment destinations.
      const pairs = extractPaymentPairs(transaction, sourceAccount);
      try {
        for (const { sender, receiver } of pairs) {
          await sanctionService.checkPartiesByAddress(sender, receiver);
        }
      } catch (err) {
        if (err instanceof SanctionScreeningError) {
          return res.json({
            status: "rejected",
            error: "Transaction rejected: account is on a sanctions list",
          } satisfies Sep8RejectedResponse);
        }
        logger.error(err, "[SEP-8] Sanctions check error:");
        return res.status(500).json({
          status: "rejected",
          error: "Internal server error during sanctions check",
        } satisfies Sep8RejectedResponse);
      }

      // All checks passed — add the bridge's authorization signature.
      const signingKeypair = StellarSdk.Keypair.fromSecret(config.signingKey);
      transaction.sign(signingKeypair);

      return res.json({
        status: "success",
        tx: transaction.toEnvelope().toXDR("base64"),
        message: "Transaction approved.",
      } satisfies Sep8SuccessResponse);
    } catch (err: any) {
      logger.error(err, "[SEP-8 /tx_approve]:");
      return res.status(500).json({
        status: "rejected",
        error: "Internal Server Error",
      } satisfies Sep8RejectedResponse);
    }
  });

  return sep8Router;
};

export default createSep8Router;
