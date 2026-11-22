import axios, { AxiosError } from "axios";
import { randomUUID } from "crypto";
import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import { resolveMoovErrorFromResponse } from "../../services/providers/errors/moovErrorMatrix";
import logger from "../../utils/logger";
import { maskPII } from "../../utils/masking";

/**
 * Moov Africa USSD push collection client (Benin, Togo, Côte d'Ivoire) --
 * #1959. Formats and submits a USSD collection request (MSISDN + amount in
 * XOF), which triggers a PIN prompt on the customer's handset.
 *
 * Moov's response to the initial POST is synchronous "accepted" (the
 * request reached the network and the USSD prompt was sent; the customer
 * still has to act on it), separate from the async completion notification
 * that arrives later via webhook once the customer enters their PIN or the
 * prompt times out. `requestCollection` only reports the synchronous half;
 * the async half is handled wherever this repo's provider webhooks land
 * (see src/routes/webhooks.ts's pattern), not by this client.
 */

const SUPPORTED_COUNTRY_CODES = ["229", "228", "225"] as const;
const CURRENCY = "XOF";

export type MoovCollectionAcceptedStatus = "ACCEPTED" | "PENDING";

export interface MoovCollectionRequest {
  /** MSISDN in local or E.164 form; normalized to 229/228/225 + subscriber number. */
  phoneNumber: string;
  /** Amount in XOF (whole units, no decimals -- XOF has no minor unit). */
  amount: number;
  requestId?: string;
}

export interface MoovCollectionAccepted {
  success: true;
  status: MoovCollectionAcceptedStatus;
  referenceId: string;
  providerTransactionId?: string;
}

export interface MoovCollectionRejected {
  success: false;
  referenceId: string;
  /** Friendly, provider-agnostic message from the error mapping utility. */
  error: string;
  /** Raw Moov error code, when the response included one, for logging/debugging. */
  providerErrorCode?: string;
  retryable: boolean;
}

export type MoovCollectionResult =
  MoovCollectionAccepted | MoovCollectionRejected;

export interface MoovClientConfig {
  baseUrl?: string;
  apiKey?: string;
  collectionPath?: string;
  timeoutMs?: number;
}

/**
 * Normalizes a Benin/Togo/Côte d'Ivoire MSISDN to `<country-code><subscriber
 * number>` with no leading `+` or `00`, matching the digits-only format
 * Moov's collection API expects (same convention as
 * services/providers/moovCoteDivoire.ts's normalizePhoneNumber, generalized
 * to all three countries this client covers).
 */
export function normalizeMsisdn(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");

  for (const code of SUPPORTED_COUNTRY_CODES) {
    if (digits.startsWith(code)) {
      return digits;
    }
  }

  // No recognized country code prefix present -- assume it's a local
  // subscriber number missing its country code entirely, which can't be
  // safely disambiguated between the three supported countries. Return the
  // digits as-is; validateMsisdn will reject it.
  return digits;
}

export function validateMsisdn(phoneNumber: string): boolean {
  const normalized = normalizeMsisdn(phoneNumber);
  return SUPPORTED_COUNTRY_CODES.some((code) =>
    new RegExp(`^${code}\\d{8,9}$`).test(normalized),
  );
}

export class MoovClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly collectionPath: string;
  private readonly timeoutMs: number;

  constructor(config: MoovClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.MOOV_USSD_BASE_URL ?? "";
    this.apiKey = config.apiKey ?? process.env.MOOV_USSD_API_KEY ?? "";
    this.collectionPath =
      config.collectionPath ??
      process.env.MOOV_USSD_COLLECTION_PATH ??
      "/v1/collections/ussd-push";
    this.timeoutMs =
      config.timeoutMs ?? (Number(process.env.MOOV_USSD_TIMEOUT_MS) || 10_000);
  }

  private joinUrl(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  /**
   * Triggers a USSD collection prompt on the subscriber's handset. Returns
   * the provider's synchronous accepted/rejected response; the eventual
   * PIN-entry or timeout outcome arrives asynchronously via webhook.
   */
  async requestCollection(
    request: MoovCollectionRequest,
  ): Promise<MoovCollectionResult> {
    const referenceId = request.requestId ?? randomUUID();
    const log = logger.child({ referenceId });

    if (!validateMsisdn(request.phoneNumber)) {
      log.warn(
        maskPII({ phoneNumber: request.phoneNumber }),
        "Moov USSD collection: unsupported or malformed MSISDN",
      );
      return {
        success: false,
        referenceId,
        error:
          "Moov USSD collection only supports Benin (229), Togo (228), and Côte d'Ivoire (225) numbers",
        retryable: false,
      };
    }

    if (!Number.isFinite(request.amount) || request.amount <= 0) {
      return {
        success: false,
        referenceId,
        error: "Collection amount must be a positive number of XOF",
        retryable: false,
      };
    }

    const msisdn = normalizeMsisdn(request.phoneNumber);

    const breakerResult = await executeWithCircuitBreaker<MoovCollectionResult>(
      {
        provider: "moov",
        operation: "ussd_collection",
        execute: async () => {
          try {
            const response = await axios.post(
              this.joinUrl(this.collectionPath),
              {
                msisdn,
                amount: request.amount,
                currency: CURRENCY,
                referenceId,
              },
              {
                headers: {
                  Authorization: `Bearer ${this.apiKey}`,
                  "Content-Type": "application/json",
                },
                timeout: this.timeoutMs,
              },
            );

            log.info(
              maskPII({ msisdn, amount: request.amount }),
              "Moov USSD collection: request accepted",
            );

            return {
              success: true,
              data: {
                success: true,
                status:
                  (response.data?.status as MoovCollectionAcceptedStatus) ??
                  "ACCEPTED",
                referenceId,
                providerTransactionId: response.data?.transactionId,
              },
            };
          } catch (error: unknown) {
            const statusCode =
              error instanceof AxiosError ? error.response?.status : undefined;
            const responseBody =
              error instanceof AxiosError
                ? (error.response?.data as Record<string, unknown> | undefined)
                : undefined;
            const providerCode =
              (responseBody?.code as string | undefined) ??
              (responseBody?.error_code as string | undefined);

            const mapped = resolveMoovErrorFromResponse(
              providerCode,
              statusCode,
            );

            log.error(
              maskPII({
                msisdn,
                statusCode,
                providerCode,
                mappedErrorCode: mapped?.errorCode,
              }),
              "Moov USSD collection: request rejected",
            );

            return {
              success: true,
              data: {
                success: false,
                referenceId,
                error: mapped?.message ?? "Moov USSD collection request failed",
                providerErrorCode: providerCode,
                retryable: mapped?.retryable ?? false,
              },
            };
          }
        },
      },
    );

    if (!breakerResult.success) {
      // The circuit is open, or the call itself threw outside the try/catch
      // above (e.g. a network-level failure the axios call didn't reach).
      return {
        success: false,
        referenceId,
        error: "Moov USSD collection service is temporarily unavailable",
        retryable: true,
      };
    }

    return breakerResult.data as MoovCollectionResult;
  }
}
