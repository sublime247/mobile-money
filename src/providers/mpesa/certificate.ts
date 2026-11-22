/**
 * Safaricom M-Pesa public certificate retrieval and caching (issue #2329).
 *
 * Daraja signs callback payloads with Safaricom's private key. The matching
 * public certificate is downloaded from the developer portal (or provided via
 * environment configuration) and cached in-process so callbacks do not pay a
 * network round trip on every request.
 *
 * Configuration (first non-empty value wins):
 *   MPESA_PUBLIC_CERT / MPESA_PUBLIC_KEY / MPESA_CERTIFICATE_PEM
 *   MPESA_CERTIFICATE_URL / SAFARICOM_CERTIFICATE_URL
 *
 * Both PEM and DER (`.cer`) certificates are accepted. A raw PEM public key is
 * also accepted for deployments that pin the key instead of the certificate.
 */

import { X509Certificate } from "crypto";
import logger from "../../utils/logger";

/** Default cache lifetime for the Safaricom certificate (24 hours). */
export const MPESA_CERTIFICATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SafaricomCertificate {
  /** PEM-encoded certificate (or raw public key when configured as such). */
  pem: string;
  /** Parsed X.509 certificate; null when a raw public key was configured. */
  certificate: X509Certificate | null;
  /** Epoch ms at which this cache entry expires. */
  expiresAt: number;
  /** Where the material came from (`env`, `url`, or `publicKey` option). */
  source: string;
}

export interface SafaricomCertificateOptions {
  /** Explicit PEM certificate or public key. */
  pem?: string;
  /** URL to download the certificate from. */
  url?: string;
  /** Cache lifetime in milliseconds. */
  ttlMs?: number;
  /** Injectable fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface CachedCertificate {
  material: SafaricomCertificate;
  cacheKey: string;
}

let cachedCertificate: CachedCertificate | null = null;

function wrapBase64Certificate(base64: string): string {
  const normalized = base64.replace(/\s+/g, "");
  if (!normalized) {
    throw new Error("Empty M-Pesa certificate");
  }
  const lines = normalized.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function isPublicKeyPem(value: string): boolean {
  return (
    value.includes("-----BEGIN PUBLIC KEY-----") ||
    value.includes("-----BEGIN RSA PUBLIC KEY-----")
  );
}

function toPem(input: string | Buffer): string {
  if (Buffer.isBuffer(input)) {
    const text = input.toString("utf8");
    if (text.includes("-----BEGIN CERTIFICATE-----") || isPublicKeyPem(text)) {
      return text;
    }
    return wrapBase64Certificate(input.toString("base64"));
  }

  const trimmed = input.trim();
  if (
    trimmed.includes("-----BEGIN CERTIFICATE-----") ||
    isPublicKeyPem(trimmed)
  ) {
    return trimmed;
  }
  return wrapBase64Certificate(trimmed);
}

function preferredEnvironmentPem(): string | undefined {
  return (
    process.env.MPESA_PUBLIC_CERT?.trim() ||
    process.env.MPESA_PUBLIC_KEY?.trim() ||
    process.env.MPESA_CERTIFICATE_PEM?.trim() ||
    undefined
  );
}

function preferredEnvironmentUrl(): string | undefined {
  return (
    process.env.MPESA_CERTIFICATE_URL?.trim() ||
    process.env.SAFARICOM_CERTIFICATE_URL?.trim() ||
    undefined
  );
}

function certificateTtl(options: SafaricomCertificateOptions): number {
  if (options.ttlMs !== undefined) return options.ttlMs;
  const configured = Number(process.env.MPESA_CERTIFICATE_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : MPESA_CERTIFICATE_CACHE_TTL_MS;
}

async function downloadCertificate(
  url: string,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download Safaricom certificate: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseMaterial(
  pem: string,
  source: string,
  expiresAt: number,
  now: number,
): SafaricomCertificate {
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    return { pem, certificate: null, expiresAt, source };
  }

  const certificate = new X509Certificate(pem);
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);

  if (Number.isFinite(validFrom) && now < validFrom) {
    throw new Error("Safaricom certificate is not valid yet");
  }
  if (Number.isFinite(validTo) && now > validTo) {
    throw new Error("Safaricom certificate has expired");
  }

  return { pem, certificate, expiresAt, source };
}

/**
 * Returns the cached Safaricom certificate/public key, downloading and
 * refreshing it when needed.
 */
export async function getSafaricomPublicCertificate(
  options: SafaricomCertificateOptions = {},
): Promise<SafaricomCertificate> {
  const now = options.now?.() ?? Date.now();
  const ttlMs = certificateTtl(options);

  const explicitPem = options.pem?.trim() || preferredEnvironmentPem();
  const url = options.url?.trim() || preferredEnvironmentUrl();
  const cacheKey = explicitPem
    ? `pem:${explicitPem.slice(0, 64)}:${explicitPem.length}`
    : `url:${url ?? ""}`;

  if (
    cachedCertificate &&
    cachedCertificate.cacheKey === cacheKey &&
    cachedCertificate.material.expiresAt > now
  ) {
    return cachedCertificate.material;
  }

  let material: string | Buffer;
  let source: string;

  if (explicitPem) {
    material = explicitPem;
    source = "env";
  } else if (url) {
    const fetcher = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw new Error("No fetch implementation available for certificate URL");
    }
    material = await downloadCertificate(url, fetcher);
    source = "url";
  } else {
    throw new Error(
      "M-Pesa public certificate is not configured (set MPESA_PUBLIC_CERT or MPESA_CERTIFICATE_URL)",
    );
  }

  const parsed = parseMaterial(toPem(material), source, now + ttlMs, now);
  cachedCertificate = { material: parsed, cacheKey };

  logger.info(
    {
      event: "mpesa.certificate.loaded",
      source: parsed.source,
      isX509: parsed.certificate !== null,
      expiresAt: new Date(parsed.expiresAt).toISOString(),
    },
    "M-Pesa public certificate loaded",
  );

  return parsed;
}

/** Clears the in-process certificate cache (tests/rotation tooling). */
export function clearSafaricomCertificateCache(): void {
  cachedCertificate = null;
}
