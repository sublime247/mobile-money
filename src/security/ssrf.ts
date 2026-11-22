/**
 * Strict SSRF validation for outgoing webhook destinations.
 *
 * Every webhook this backend sends is a server-side request to a URL that an
 * external party controls (merchants register callback URLs, SEP anchors and
 * clients supply `callback` parameters, retry workers replay stored URLs).
 * Without validation, "point your webhook at `http://169.254.169.254/`" turns
 * the delivery worker into a request-forgery primitive against the cloud
 * metadata endpoint, loopback admin APIs and the private network.
 *
 * Two layers of defence:
 *
 *  1. {@link assertSafeWebhookUrl} — synchronous, no I/O. Rejects dangerous
 *     schemes, embedded credentials, internal hostname patterns, single-label
 *     hosts, port 0, and any URL whose host is already an IP literal in a
 *     private / loopback / link-local / reserved range (including the forms a
 *     WHATWG URL parser normalises `0x7f.0.0.1` and `2130706433` into).
 *
 *  2. {@link validateWebhookUrl} — everything in (1) plus DNS resolution:
 *     *every* address the hostname resolves to must be publicly routable, so
 *     names like `metadata.google.internal` or a public hostname rebound to
 *     `10.0.0.5` are rejected. Fails closed when the name cannot be resolved,
 *     because "does not resolve right now" is trivially attacker-controlled.
 *
 * DNS enforcement can be turned off with `WEBHOOK_SSRF_RESOLVE_DNS=false` for
 * air-gapped / offline test runs; layer (1) still applies there. Tests that
 * need the DNS layer either flip the flag back on or pass an injected
 * resolver.
 */
import { promises as dns } from "dns";
import { isIP } from "net";

/** Thrown whenever a destination fails validation. Callers should treat this
 *  as a permanent failure — retrying cannot make a blocked URL safe. */
export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  /** The original, unvalidated URL that was rejected. */
  readonly destination: string;

  constructor(message: string, destination: string) {
    super(message);
    this.name = "SsrfBlockedError";
    this.destination = destination;
  }
}

/** Signature of an injectable DNS resolver (tests pass their own). */
export type HostResolver = (hostname: string) => Promise<string[]>;

export interface WebhookUrlValidationOptions {
  /**
   * DNS resolver to use. When provided it always runs, regardless of
   * `WEBHOOK_SSRF_RESOLVE_DNS` — this is how tests exercise the resolution
   * layer offline.
   */
  resolve?: HostResolver;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that are never a legitimate external webhook receiver. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost", // RFC 6761 loopback
  "metadata", // shorthand used inside cloud VPCs
  "metadata.google.internal", // GCP metadata server
  "instance-data", // legacy AWS/OpenStack metadata alias
]);

/** Suffixes that only ever resolve inside an internal network. */
const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local", // mDNS / RFC 6762
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".private",
  ".home.arpa", // RFC 8375 home networks
];

function block(message: string, rawUrl: string): never {
  throw new SsrfBlockedError(message, rawUrl);
}

/**
 * RFC 4291 expansion to eight 16-bit groups, so range checks are simple
 * bitmask tests. Returns `null` when the literal cannot be parsed — callers
 * fail closed on `null`.
 */
function expandIpv6(address: string): number[] | null {
  const cleaned = address.split("%")[0].toLowerCase();
  if (!cleaned.includes(":")) return null;

  const compression = cleaned.indexOf("::");
  const head = compression === -1 ? cleaned : cleaned.slice(0, compression);
  const tail = compression === -1 ? "" : cleaned.slice(compression + 2);

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
        if (isIP(piece) !== 4) return null;
        const [a, b, c, d] = piece.split(".").map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);
  if (!headGroups || !tailGroups) return null;

  if (compression === -1) {
    return headGroups.length === 8 ? headGroups : null;
  }
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 1) return null;
  return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
}

function groupsToIpv4(high: number, low: number): string {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    ".",
  );
}

/**
 * True for IPv4 ranges a webhook must never reach: loopback, RFC 1918
 * private space, link-local (cloud metadata lives at 169.254.169.254),
 * CGNAT, unspecified, multicast/reserved and documentation ranges.
 */
function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".");
  if (octets.length !== 4) return true;
  if (!octets.every((part) => /^\d{1,3}$/.test(part))) return true;

  const [a, b, c] = octets.map(Number);
  if (octets.some((part) => Number(part) > 255)) return true;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** True for IPv6 ranges a webhook must never reach. */
function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true; // unparseable → fail closed

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    // ::/96 — the deprecated IPv4-compatible space (::1 loopback included).
    return true;
  }
  if (g5 === 0xffff) {
    // ::ffff:0:0/96 IPv4-mapped — judge the embedded IPv4 address.
    return isBlockedIpv4(groupsToIpv4(g6, g7));
  }
  if (
    g0 === 0x64 &&
    g1 === 0xff9b &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0
  ) {
    return isBlockedIpv4(groupsToIpv4(g6, g7)); // 64:ff9b::/96 NAT64
  }
  if (g0 === 0x2002) return isBlockedIpv4(groupsToIpv4(g1, g2)); // 2002::/16 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // 2001:0::/32 Teredo
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 docs
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64
  return false;
}

/**
 * True when an IP literal must not be contacted by a webhook delivery:
 * private, loopback, link-local, multicast, reserved — or unparseable, which
 * is treated as blocked rather than waved through.
 */
export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

/** Lowercases, drops IPv6 brackets, the zone id and a trailing dot. */
function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** The IP literal a hostname already is, or `null` when it is a DNS name. */
function ipLiteralOf(hostname: string): string | null {
  const host = normalizeHostname(hostname);
  return isIP(host) === 0 ? null : host;
}

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  // A single label has no public suffix — it can only resolve internally.
  return !host.includes(".");
}

async function resolveWithDns(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/** DNS enforcement toggle. On by default; only long-running offline test
 *  environments should turn it off (layer 1 still applies). */
function dnsCheckEnabled(): boolean {
  const raw = (process.env.WEBHOOK_SSRF_RESOLVE_DNS ?? "").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * Synchronous part of the guard: scheme, credentials, hostname shape and
 * already-literal addresses. Throws {@link SsrfBlockedError}; returns the
 * parsed URL so callers can reuse it.
 */
export function assertSafeWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return block("url must be a valid absolute URL", rawUrl);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return block(
      `url scheme "${url.protocol}" is not allowed; use http or https`,
      rawUrl,
    );
  }
  if (url.username !== "" || url.password !== "") {
    return block("url must not contain embedded credentials", rawUrl);
  }
  if (url.port === "0") {
    return block("url port 0 is not allowed", rawUrl);
  }

  const host = normalizeHostname(url.hostname);
  if (host === "") return block("url must contain a host", rawUrl);

  const literal = ipLiteralOf(host);
  if (literal !== null) {
    if (isBlockedIpAddress(literal)) {
      return block(
        `url host "${literal}" is a private or reserved address`,
        rawUrl,
      );
    }
  } else if (isBlockedHostname(host)) {
    return block(`url host "${host}" is not allowed`, rawUrl);
  }

  return url;
}

/**
 * Full guard: the synchronous checks plus DNS resolution of the hostname.
 * Every resolved address must be publicly routable; an unresolvable name is
 * rejected. Throws {@link SsrfBlockedError} on any violation.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  options: WebhookUrlValidationOptions = {},
): Promise<URL> {
  const url = assertSafeWebhookUrl(rawUrl);
  const host = normalizeHostname(url.hostname);

  if (ipLiteralOf(host) !== null) return url; // already vetted synchronously

  const resolve = options.resolve;
  if (!resolve && !dnsCheckEnabled()) return url;

  let addresses: string[];
  try {
    addresses = await (resolve ?? resolveWithDns)(host);
  } catch {
    return block(`url host "${host}" could not be resolved`, rawUrl);
  }
  if (addresses.length === 0) {
    return block(`url host "${host}" could not be resolved`, rawUrl);
  }

  for (const address of addresses) {
    if (isBlockedIpAddress(address)) {
      return block(
        `url host "${host}" resolves to a private or reserved address (${address})`,
        rawUrl,
      );
    }
  }

  return url;
}
