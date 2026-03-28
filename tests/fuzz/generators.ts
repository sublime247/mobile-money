/**
 * Lightweight property-based generator library for fuzz testing.
 *
 * Mirrors the fast-check (fc) API surface so this file can be swapped for
 * `import * as fc from "fast-check"` once that package is installed.
 *
 * To install fast-check:
 *   npm install --save-dev fast-check
 * Then replace this file with:
 *   export { fc } from "fast-check";
 *
 * Usage:
 *   const samples = fc.sample(fc.string(), 50);
 *   fc.assert(fc.property(fc.string(), (s) => s.length >= 0));
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal PRNG (xorshift32) — deterministic but cheap
// ─────────────────────────────────────────────────────────────────────────────

let _seed = 0xdeadbeef;

function rand(): number {
  _seed ^= _seed << 13;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;
  return (_seed >>> 0) / 0xffffffff;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

/** Reset to a known seed so runs are reproducible. */
export function seed(s: number): void {
  _seed = s >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Arbitrary<T>
// ─────────────────────────────────────────────────────────────────────────────

export interface Arbitrary<T> {
  generate(): T;
}

function arb<T>(gen: () => T): Arbitrary<T> {
  return { generate: gen };
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Arbitrary boolean. */
export const boolean = (): Arbitrary<boolean> => arb(() => rand() < 0.5);

/** Arbitrary integer, defaulting to a full range that includes edge cases. */
export const integer = (
  opts: { min?: number; max?: number } = {},
): Arbitrary<number> => {
  const { min = -2147483648, max = 2147483647 } = opts;
  // 10 % chance of returning an integer boundary value
  const boundaries = [0, -1, 1, min, max, 2147483647, -2147483648];
  return arb(() => (rand() < 0.1 ? pick(boundaries) : randInt(min, max)));
};

/** Arbitrary float including special values. */
export const float = (): Arbitrary<number> => {
  const specials = [0, -0, Infinity, -Infinity, NaN, Number.MAX_VALUE,
                    Number.MIN_VALUE, Number.EPSILON, -Number.MAX_VALUE];
  return arb(() => (rand() < 0.15 ? pick(specials) : (rand() * 2e6 - 1e6)));
};

/** Arbitrary ASCII printable string of variable length. */
export const string = (opts: { minLength?: number; maxLength?: number } = {}): Arbitrary<string> => {
  const { minLength = 0, maxLength = 200 } = opts;
  const charset =
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
    "[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  return arb(() => {
    const len = randInt(minLength, maxLength);
    return Array.from({ length: len }, () => pick([...charset])).join("");
  });
};

/** Constant from a fixed set — always one of the supplied values. */
export const constantFrom = <T>(...values: [T, ...T[]]): Arbitrary<T> =>
  arb(() => pick(values));

/** Arbitrary UUID v4-ish (not cryptographically correct, but syntactically valid). */
export const uuid = (): Arbitrary<string> => {
  const hex = () => randInt(0, 15).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join("");
  return arb(() => `${seg(8)}-${seg(4)}-4${seg(3)}-${pick(["8","9","a","b"])}${seg(3)}-${seg(12)}`);
};

/** Arbitrary date string (ISO 8601). */
export const isoDate = (): Arbitrary<string> => {
  const year  = arb(() => randInt(1970, 2099));
  const month = arb(() => String(randInt(1, 12)).padStart(2, "0"));
  const day   = arb(() => String(randInt(1, 28)).padStart(2, "0"));
  return arb(() => `${year.generate()}-${month.generate()}-${day.generate()}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Attack / boundary strings
// ─────────────────────────────────────────────────────────────────────────────

/** A curated pool of strings that commonly trigger bugs. */
export const ATTACK_STRINGS = [
  // Empty / whitespace
  "", " ", "\t", "\n", "\r\n",
  // Very long
  "A".repeat(10_000),
  "A".repeat(100_000),
  // Null / control characters
  "\0",
  "\u0000",
  "a\0b",
  // Unicode extremes
  "😀".repeat(500),
  "\u{1F4A9}",
  "\uFEFF",   // BOM
  "\uD800",   // lone surrogate
  "\uFFFF",
  // SQL injection classics
  "' OR '1'='1",
  "'; DROP TABLE users; --",
  "1; SELECT * FROM information_schema.tables",
  "UNION SELECT NULL,NULL,NULL--",
  // XSS
  "<script>alert(1)</script>",
  "\"><img src=x onerror=alert(1)>",
  "javascript:alert(1)",
  // Path traversal
  "../../../etc/passwd",
  "..%2F..%2F..%2Fetc%2Fpasswd",
  "%00",
  // JSON injection
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  // Numeric strings
  "NaN", "Infinity", "-Infinity", "1e308", "-1e308",
  "9999999999999999999999999",
  // Format strings
  "%s%s%s%s%s",
  "%d%d%d%d%d",
  // CRLF injection
  "foo\r\nX-Injected: bar",
  // Template injection
  "{{7*7}}", "${7*7}", "#{7*7}",
  // RegExp DoS
  "a".repeat(30) + "!",
  // Type confusion
  "true", "false", "null", "undefined", "[]", "{}",
  // Overflows
  String(Number.MAX_SAFE_INTEGER),
  String(Number.MIN_SAFE_INTEGER),
  String(2**53),
] as const;

/** Arbitrary malicious / boundary string drawn from ATTACK_STRINGS. */
export const attackString = (): Arbitrary<string> =>
  arb(() => pick(ATTACK_STRINGS as unknown as string[]));

/** Either a normal string or an attack string (50/50 split). */
export const anyString = (): Arbitrary<string> =>
  arb(() => (rand() < 0.5 ? string().generate() : attackString().generate()));

// ─────────────────────────────────────────────────────────────────────────────
// Composites
// ─────────────────────────────────────────────────────────────────────────────

/** Arbitrary JSON-serialisable value (may be nested). */
export const anything = (depth = 0): Arbitrary<unknown> =>
  arb(() => {
    const r = rand();
    if (r < 0.15) return null;
    if (r < 0.25) return boolean().generate();
    if (r < 0.38) return integer().generate();
    if (r < 0.50) return float().generate();
    if (r < 0.70 || depth >= 3) return anyString().generate();
    if (r < 0.85) return Array.from({ length: randInt(0, 5) }, () => anything(depth + 1).generate());
    // object
    const keys = Array.from({ length: randInt(0, 4) }, () => string({ maxLength: 20 }).generate());
    return Object.fromEntries(keys.map((k) => [k, anything(depth + 1).generate()]));
  });

/** Arbitrary record with a fixed shape, each value drawn from its own arbitrary. */
export function record<T extends Record<string, Arbitrary<unknown>>>(
  shape: T,
): Arbitrary<{ [K in keyof T]: ReturnType<T[K]["generate"]> }> {
  return arb(() => {
    const result: Record<string, unknown> = {};
    for (const [k, a] of Object.entries(shape)) {
      result[k] = a.generate();
    }
    return result as { [K in keyof T]: ReturnType<T[K]["generate"]> };
  });
}

/** Arbitrary array whose elements come from the given arbitrary. */
export function array<T>(
  inner: Arbitrary<T>,
  opts: { minLength?: number; maxLength?: number } = {},
): Arbitrary<T[]> {
  const { minLength = 0, maxLength = 10 } = opts;
  return arb(() =>
    Array.from({ length: randInt(minLength, maxLength) }, () => inner.generate()),
  );
}

/** One of several arbitraries, chosen uniformly. */
export function oneOf<T>(...arbitraries: [Arbitrary<T>, ...Arbitrary<T>[]]): Arbitrary<T> {
  return arb(() => pick(arbitraries).generate());
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

interface PropertyOptions {
  /** Number of test cases to generate. Default: 100 */
  numRuns?: number;
  /** Seed for reproducibility. Default: random */
  seed?: number;
}

type Property<T> = {
  arb: Arbitrary<T>;
  predicate: (value: T) => boolean | Promise<boolean>;
};

/** Build a property from an arbitrary and a predicate. */
export function property<T>(
  arb: Arbitrary<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
): Property<T> {
  return { arb, predicate };
}

/**
 * Run a property-based test. Throws on the first falsifying example.
 * Compatible with Jest's async test runner.
 */
export async function assert<T>(
  prop: Property<T>,
  opts: PropertyOptions = {},
): Promise<void> {
  const { numRuns = 100 } = opts;
  if (opts.seed !== undefined) seed(opts.seed);

  for (let i = 0; i < numRuns; i++) {
    const value = prop.arb.generate();
    let ok: boolean;
    try {
      ok = await prop.predicate(value);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Property failed after ${i + 1} run(s).\nFalsifying value: ${JSON.stringify(value)}\nError: ${msg}`,
      );
    }
    if (!ok) {
      throw new Error(
        `Property falsified after ${i + 1} run(s).\nFalsifying value: ${JSON.stringify(value)}`,
      );
    }
  }
}

/**
 * Collect `count` samples from an arbitrary — useful for generating test
 * inputs without the full property-check machinery.
 */
export function sample<T>(arb: Arbitrary<T>, count: number): T[] {
  return Array.from({ length: count }, () => arb.generate());
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain-specific arbitraries for this API
// ─────────────────────────────────────────────────────────────────────────────

/** Stellar-like G-address (56 chars, Base32 alphabet). */
export const stellarAddress = (): Arbitrary<string> => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return arb(() => "G" + Array.from({ length: 55 }, () => pick([...chars])).join(""));
};

/** Phone number string — valid-ish E.164 or completely fuzzed. */
export const phoneNumber = (): Arbitrary<string> =>
  oneOf(
    arb(() => `+${randInt(1, 999)}${randInt(100000000, 9999999999)}`),
    attackString(),
    string({ maxLength: 30 }),
  );

/** Federation address (local*domain form or garbage). */
export const federationAddress = (): Arbitrary<string> =>
  oneOf(
    arb(() => `${string({ maxLength: 30 }).generate()}*${string({ maxLength: 30 }).generate()}`),
    attackString(),
    string(),
  );

/** Pagination params object. */
export const paginationParams = (): Arbitrary<Record<string, string>> =>
  arb(() => ({
    offset: String(oneOf(integer({ min: -10, max: 1000 }), attackString()).generate()),
    limit:  String(oneOf(integer({ min: -10, max: 10000 }), attackString()).generate()),
  }));

/** Status filter string. */
export const transactionStatus = (): Arbitrary<string> =>
  oneOf(
    constantFrom("pending", "completed", "failed", "cancelled"),
    attackString(),
    string(),
  );

/** JWT-shaped string (three dot-separated segments or garbage). */
export const jwtString = (): Arbitrary<string> =>
  oneOf(
    arb(() => {
      const part = () => Buffer.from(anyString().generate()).toString("base64url");
      return `${part()}.${part()}.${part()}`;
    }),
    attackString(),
    string(),
  );
