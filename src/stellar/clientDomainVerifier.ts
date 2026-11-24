import * as StellarSdk from "@stellar/stellar-sdk";
import { promises as dns } from "dns";
import logger from "../utils/logger";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

/**
 * SEP-10 Client Domain Verifier (SEP-10 v3.2+)
 *
 * When a client signs a challenge transaction containing the `client_domain`
 * ManageData operation, the server verifies that the signing account is authorized
 * in the client domain's `stellar.toml` or DNS TXT records.
 *
 * Authorization rules:
 * 1. stellar.toml check:
 *    - Fetched via HTTPS from `https://<client_domain>/.well-known/stellar.toml`
 *      with strict timeout (default 5000ms) and max 100KB size limit.
 *    - The public key must match `SIGNING_KEY` or be present in the `ACCOUNTS` list.
 * 2. DNS TXT record fallback / check:
 *    - Queried via DNS TXT on `_stellar.<client_domain>` and `<client_domain>`.
 *    - Authorizes if record contains the key (e.g. `stellar_signing_key=<KEY>`,
 *      `SIGNING_KEY=<KEY>`, `stellar=<KEY>`, or raw public key).
 * 3. Rejects with 400 Bad Request if client domain does not authorize client public key.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const STELLAR_TOML_MAX_BYTES = 100 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;

const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const CLIENT_DOMAIN_PATTERN = new RegExp(
  `^(?:${DOMAIN_LABEL}\\.)+[a-z]{2,63}$`,
);
const LOCAL_DOMAIN_PATTERN = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

export interface ClientDomainTomlData {
  signingKey: string | null;
  accounts: string[];
  fetchedAt: number;
}

export interface ClientDomainVerificationResult {
  authorized: boolean;
  source: "stellar_toml" | "dns_txt" | "none";
  signingKey?: string | null;
  accounts?: string[];
  authorizedKeys?: string[];
  error?: string;
}

export interface VerifyClientDomainOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  dnsResolver?: (domain: string) => Promise<string[][]>;
  skipCache?: boolean;
}

const tomlCache = new Map<string, ClientDomainTomlData>();

export function clearClientDomainVerifierCache(): void {
  tomlCache.clear();
}

export function isLocalDomain(domain: string): boolean {
  return LOCAL_DOMAIN_PATTERN.test(domain);
}

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
 */
export function parseStellarTomlSigningKey(toml: string): string | null {
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // First table header ends the root table
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
 * Extract `ACCOUNTS` array or list from a stellar.toml document.
 */
export function parseStellarTomlAccounts(toml: string): string[] {
  const accounts: string[] = [];
  const lines = toml.split(/\r?\n/);
  let insideAccountsArray = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Check single-line or multi-line ACCOUNTS = [ ... ]
    if (!insideAccountsArray) {
      // Table header in TOML ends top-level parsing unless inside table
      if (line.startsWith("[[ACCOUNTS]]") || line.startsWith("[accounts]")) {
        continue;
      }
      if (line.startsWith("[")) {
        // Table boundary reached
      }

      const match = line.match(/^ACCOUNTS\s*=\s*\[(.*?)\]/);
      if (match) {
        // Single-line ACCOUNTS array
        const inner = match[1];
        const keyMatches = inner.match(/(?:"([^"]*)"|'([^']*)')/g) || [];
        for (const raw of keyMatches) {
          const cleaned = raw.replace(/["']/g, "").trim();
          if (
            StellarSdk.StrKey.isValidEd25519PublicKey(cleaned) &&
            !accounts.includes(cleaned)
          ) {
            accounts.push(cleaned);
          }
        }
        continue;
      }

      if (/^ACCOUNTS\s*=\s*\[/.test(line)) {
        insideAccountsArray = true;
        const afterBracket = line.replace(/^ACCOUNTS\s*=\s*\[/, "");
        const keyMatches = afterBracket.match(/(?:"([^"]*)"|'([^']*)')/g) || [];
        for (const raw of keyMatches) {
          const cleaned = raw.replace(/["']/g, "").trim();
          if (
            StellarSdk.StrKey.isValidEd25519PublicKey(cleaned) &&
            !accounts.includes(cleaned)
          ) {
            accounts.push(cleaned);
          }
        }
        if (line.includes("]")) {
          insideAccountsArray = false;
        }
        continue;
      }
    } else {
      // Inside multi-line array
      const keyMatches = line.match(/(?:"([^"]*)"|'([^']*)')/g) || [];
      for (const raw of keyMatches) {
        const cleaned = raw.replace(/["']/g, "").trim();
        if (
          StellarSdk.StrKey.isValidEd25519PublicKey(cleaned) &&
          !accounts.includes(cleaned)
        ) {
          accounts.push(cleaned);
        }
      }
      if (line.includes("]")) {
        insideAccountsArray = false;
      }
    }
  }

  return accounts;
}

/**
 * Parses both SIGNING_KEY and ACCOUNTS from a stellar.toml document.
 */
export function parseStellarToml(toml: string): {
  signingKey: string | null;
  accounts: string[];
} {
  return {
    signingKey: parseStellarTomlSigningKey(toml),
    accounts: parseStellarTomlAccounts(toml),
  };
}

/**
 * Fetches and parses stellar.toml from client domain with strict timeout.
 */
export async function fetchClientDomainToml(
  domain: string,
  options?: {
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    skipCache?: boolean;
  },
): Promise<ClientDomainTomlData> {
  const normalized = parseClientDomain(domain);

  if (!options?.skipCache) {
    const cached = tomlCache.get(normalized);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
  }

  const protocol = isLocalDomain(normalized) ? "http" : "https";
  const url = `${protocol}://${normalized}/.well-known/stellar.toml`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const customFetch = options?.fetchFn || globalThis.fetch;
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

    const { signingKey, accounts } = parseStellarToml(text);
    const result: ClientDomainTomlData = {
      signingKey,
      accounts,
      fetchedAt: Date.now(),
    };

    tomlCache.set(normalized, result);
    return result;
  } catch (error: any) {
    logger.warn(
      { clientDomain: normalized, err: error.message },
      "[SEP-10] Failed to fetch stellar.toml for client domain",
    );
    throw new Error(
      `Client domain stellar.toml fetch failed: ${error.message || "Unknown error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queries DNS TXT records for authorized Stellar public keys on `_stellar.<domain>`
 * and `<domain>`.
 */
export async function lookupClientDomainDnsTxt(
  domain: string,
  dnsResolver?: (name: string) => Promise<string[][]>,
): Promise<string[]> {
  const normalized = parseClientDomain(domain);
  const authorizedKeys: string[] = [];
  const resolver =
    dnsResolver ?? ((name: string) => dns.resolveTxt(name));

  const namesToQuery = [`_stellar.${normalized}`, normalized];

  for (const queryName of namesToQuery) {
    try {
      const records = await resolver(queryName);
      if (!Array.isArray(records)) continue;

      for (const recordChunks of records) {
        const fullRecord = Array.isArray(recordChunks)
          ? recordChunks.join("")
          : String(recordChunks);

        // Pattern 1: stellar_signing_key=G... or SIGNING_KEY=G... or stellar=G...
        const prefixMatch = fullRecord.match(
          /(?:stellar_signing_key|SIGNING_KEY|stellar|key)\s*=\s*(G[A-Z0-9]{55})/i,
        );
        if (prefixMatch && StellarSdk.StrKey.isValidEd25519PublicKey(prefixMatch[1])) {
          if (!authorizedKeys.includes(prefixMatch[1])) {
            authorizedKeys.push(prefixMatch[1]);
          }
        }

        // Pattern 2: direct Ed25519 public key
        const rawKeyMatches = fullRecord.match(/\b(G[A-Z0-9]{55})\b/g) || [];
        for (const candidate of rawKeyMatches) {
          if (
            StellarSdk.StrKey.isValidEd25519PublicKey(candidate) &&
            !authorizedKeys.includes(candidate)
          ) {
            authorizedKeys.push(candidate);
          }
        }
      }
    } catch (err: any) {
      // DNS record not found or DNS error
      logger.debug(
        { queryName, err: err?.message },
        "[SEP-10] DNS TXT query returned no matching record",
      );
    }
  }

  return authorizedKeys;
}

/**
 * Verifies whether `clientPublicKey` is authorized by `clientDomain` via either
 * stellar.toml (SIGNING_KEY or ACCOUNTS) or DNS TXT records.
 */
export async function verifyClientDomain(
  clientDomain: string,
  clientPublicKey: string,
  options?: VerifyClientDomainOptions,
): Promise<ClientDomainVerificationResult> {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(clientPublicKey)) {
    return {
      authorized: false,
      source: "none",
      error: `Invalid Stellar public key: ${clientPublicKey}`,
    };
  }

  let normalizedDomain: string;
  try {
    normalizedDomain = parseClientDomain(clientDomain);
  } catch (err: any) {
    return {
      authorized: false,
      source: "none",
      error: err.message,
    };
  }

  // 1. Try stellar.toml verification
  let tomlData: ClientDomainTomlData | null = null;
  try {
    tomlData = await fetchClientDomainToml(normalizedDomain, {
      timeoutMs: options?.timeoutMs,
      fetchFn: options?.fetchFn,
      skipCache: options?.skipCache,
    });

    const isSigningKeyMatch = tomlData.signingKey === clientPublicKey;
    const isAccountsMatch = tomlData.accounts.includes(clientPublicKey);

    if (isSigningKeyMatch || isAccountsMatch) {
      return {
        authorized: true,
        source: "stellar_toml",
        signingKey: tomlData.signingKey,
        accounts: tomlData.accounts,
      };
    }
  } catch (tomlError: any) {
    logger.debug(
      { domain: normalizedDomain, err: tomlError.message },
      "[SEP-10] stellar.toml check failed, falling back to DNS TXT",
    );
  }

  // 2. Try DNS TXT record lookup
  try {
    const authorizedDnsKeys = await lookupClientDomainDnsTxt(
      normalizedDomain,
      options?.dnsResolver,
    );

    if (authorizedDnsKeys.includes(clientPublicKey)) {
      return {
        authorized: true,
        source: "dns_txt",
        authorizedKeys: authorizedDnsKeys,
      };
    }
  } catch (dnsError: any) {
    logger.warn(
      { domain: normalizedDomain, err: dnsError.message },
      "[SEP-10] DNS TXT lookup failed",
    );
  }

  return {
    authorized: false,
    source: "none",
    signingKey: tomlData?.signingKey,
    accounts: tomlData?.accounts,
    error: `Client domain ${normalizedDomain} does not authorize client public key ${clientPublicKey}`,
  };
}

/**
 * Asserts that `clientPublicKey` is authorized by `clientDomain`.
 * Throws an INVALID_INPUT error (400 Bad Request) if unauthorized.
 */
export async function assertClientDomainAuthorized(
  clientDomain: string,
  clientPublicKey: string,
  options?: VerifyClientDomainOptions,
): Promise<ClientDomainVerificationResult> {
  const result = await verifyClientDomain(
    clientDomain,
    clientPublicKey,
    options,
  );

  if (!result.authorized) {
    const message =
      result.error ||
      `Client domain "${clientDomain}" does not authorize client public key "${clientPublicKey}"`;
    throw createError(ERROR_CODES.INVALID_INPUT, message, {
      error: message,
      client_domain: clientDomain,
      account: clientPublicKey,
    });
  }

  return result;
}
