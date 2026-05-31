/**
 * Unit tests for the historical price ticker service.
 * DB and axios are mocked — these are pure logic tests.
 */

import axios from "axios";

// ── DB mock ─────────────────────────────────────────────────────────────────
//
// The in-memory store mimics the historical_prices table's unique constraint
// on (base, quote, recorded_at) — an upsert overwrites the existing row for
// the same hour bucket.

type Row = {
  id: string;
  base_currency: string;
  quote_currency: string;
  price: string;
  source: string;
  recorded_at: Date;
  fetched_at: Date;
  created_at: Date;
};

const rows: Row[] = [];
let idSeq = 1;

function upsert(
  base: string,
  quote: string,
  price: number,
  source: string,
  recordedAtISO: string,
): Row {
  const recordedAt = new Date(recordedAtISO);
  const key = `${base}|${quote}|${recordedAt.toISOString()}`;
  const existing = rows.findIndex(
    (r) =>
      `${r.base_currency}|${r.quote_currency}|${r.recorded_at.toISOString()}` ===
      key,
  );
  const now = new Date();
  const row: Row = {
    id: String(idSeq++),
    base_currency: base,
    quote_currency: quote,
    price: String(price),
    source,
    recorded_at: recordedAt,
    fetched_at: now,
    created_at: existing >= 0 ? rows[existing].created_at : now,
  };
  if (existing >= 0) rows[existing] = row;
  else rows.push(row);
  return row;
}

jest.mock("../../src/config/database", () => ({
  pool: {} as any,
  async queryWrite(text: string, params: unknown[] = []) {
    if (/INSERT INTO historical_prices/i.test(text)) {
      const [base, quote, price, source, recordedAt] = params as [
        string,
        string,
        number,
        string,
        string,
      ];
      const row = upsert(base, quote, Number(price), source, recordedAt);
      return { rows: [row] };
    }
    throw new Error(`Unhandled queryWrite: ${text}`);
  },
  async queryRead(text: string, params: unknown[] = []) {
    if (
      /SELECT[\s\S]+FROM historical_prices[\s\S]+ORDER BY recorded_at DESC\s+LIMIT 1/i.test(
        text,
      )
    ) {
      if (/recorded_at <= \$3/i.test(text)) {
        const [base, quote, at] = params as [string, string, string];
        const cutoff = new Date(at).getTime();
        const match = rows
          .filter(
            (r) =>
              r.base_currency === base &&
              r.quote_currency === quote &&
              r.recorded_at.getTime() <= cutoff,
          )
          .sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime())[0];
        return { rows: match ? [match] : [] };
      }
      // findLatest
      const [base, quote] = params as [string, string];
      const match = rows
        .filter((r) => r.base_currency === base && r.quote_currency === quote)
        .sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime())[0];
      return { rows: match ? [match] : [] };
    }
    if (/recorded_at BETWEEN \$3 AND \$4/i.test(text)) {
      const [base, quote, from, to, limit] = params as [
        string,
        string,
        string,
        string,
        number,
      ];
      const fromMs = new Date(from).getTime();
      const toMs = new Date(to).getTime();
      const matches = rows
        .filter(
          (r) =>
            r.base_currency === base &&
            r.quote_currency === quote &&
            r.recorded_at.getTime() >= fromMs &&
            r.recorded_at.getTime() <= toMs,
        )
        .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime())
        .slice(0, limit);
      return { rows: matches };
    }
    throw new Error(`Unhandled queryRead: ${text}`);
  },
  async querySmart() {
    throw new Error("not used in tests");
  },
}));

// ── axios mock ──────────────────────────────────────────────────────────────

jest.mock("axios");
const axiosMock = axios as jest.Mocked<typeof axios>;

function mockCoinGeckoOnce(price: number) {
  axiosMock.get.mockResolvedValueOnce({
    data: { stellar: { usd: price } },
  } as any);
}

function mockExchangeRateOnce(xafPerUsd: number) {
  axiosMock.get.mockResolvedValueOnce({
    data: {
      result: "success",
      base_code: "USD",
      conversion_rates: { USD: 1, XAF: xafPerUsd },
    },
  } as any);
}

// ─── Imports after mocks ────────────────────────────────────────────────────

import {
  captureSnapshot,
  valueAtTime,
  findNearest,
  findLatest,
  findRange,
} from "../../src/services/priceTicker";
import { truncateToHour } from "../../src/models/historicalPrice";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("truncateToHour", () => {
  it("zeros minutes, seconds, and ms", () => {
    const d = new Date("2026-04-23T14:37:29.123Z");
    const t = truncateToHour(d);
    expect(t.toISOString()).toBe("2026-04-23T14:00:00.000Z");
  });

  it("is idempotent for already-truncated dates", () => {
    const d = new Date("2026-04-23T14:00:00.000Z");
    expect(truncateToHour(d).toISOString()).toBe(d.toISOString());
  });
});

describe("captureSnapshot", () => {
  beforeEach(() => {
    rows.length = 0;
    idSeq = 1;
    axiosMock.get.mockReset();
    process.env.EXCHANGE_RATE_API_KEY = "test-key";
  });

  it("stores XLM/USD, USD/XAF, and derived XLM/XAF", async () => {
    mockCoinGeckoOnce(0.12);
    mockExchangeRateOnce(620);

    const at = new Date("2026-04-23T12:30:00.000Z");
    const result = await captureSnapshot(at);

    expect(result.errors).toHaveLength(0);
    expect(result.snapshots).toHaveLength(3);

    const pairs = result.snapshots.map(
      (s) => `${s.baseCurrency}/${s.quoteCurrency}`,
    );
    expect(pairs).toEqual(["XLM/USD", "USD/XAF", "XLM/XAF"]);

    const derived = result.snapshots.find(
      (s) => s.baseCurrency === "XLM" && s.quoteCurrency === "XAF",
    )!;
    expect(derived.price).toBeCloseTo(0.12 * 620, 8);
    expect(derived.source).toBe("derived");
  });

  it("truncates recordedAt to the UTC hour", async () => {
    mockCoinGeckoOnce(0.1);
    mockExchangeRateOnce(600);

    const at = new Date("2026-04-23T09:45:12.000Z");
    const result = await captureSnapshot(at);

    expect(result.recordedAt.toISOString()).toBe("2026-04-23T09:00:00.000Z");
    for (const s of result.snapshots) {
      expect(s.recordedAt.toISOString()).toBe("2026-04-23T09:00:00.000Z");
    }
  });

  it("continues when CoinGecko fails and skips the derived pair", async () => {
    axiosMock.get.mockRejectedValueOnce(new Error("coingecko down"));
    mockExchangeRateOnce(605);

    const result = await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].pair).toBe("XLM/USD");
    const pairs = result.snapshots.map(
      (s) => `${s.baseCurrency}/${s.quoteCurrency}`,
    );
    expect(pairs).toEqual(["USD/XAF"]); // no XLM/USD, no derived XLM/XAF
  });

  it("continues when exchangerate-api fails and skips the derived pair", async () => {
    mockCoinGeckoOnce(0.15);
    axiosMock.get.mockRejectedValueOnce(new Error("exchangerate down"));

    const result = await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    const pairs = result.snapshots.map(
      (s) => `${s.baseCurrency}/${s.quoteCurrency}`,
    );
    expect(pairs).toEqual(["XLM/USD"]);
    expect(result.errors.map((e) => e.pair)).toContain("USD/XAF");
  });

  it("rejects invalid CoinGecko payloads", async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { stellar: {} } } as any);
    mockExchangeRateOnce(600);

    const result = await captureSnapshot(new Date("2026-04-23T10:00:00Z"));
    expect(result.errors.map((e) => e.pair)).toContain("XLM/USD");
  });

  it("upserts on re-capture for the same hour", async () => {
    mockCoinGeckoOnce(0.1);
    mockExchangeRateOnce(600);
    await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    mockCoinGeckoOnce(0.11);
    mockExchangeRateOnce(610);
    await captureSnapshot(new Date("2026-04-23T10:15:00Z"));

    // Still only 3 rows — the second call overwrote the first.
    expect(rows).toHaveLength(3);
    const xlmUsd = rows.find(
      (r) => r.base_currency === "XLM" && r.quote_currency === "USD",
    )!;
    expect(Number(xlmUsd.price)).toBe(0.11);
  });

  it("errors out when EXCHANGE_RATE_API_KEY is missing", async () => {
    delete process.env.EXCHANGE_RATE_API_KEY;
    mockCoinGeckoOnce(0.1);

    const result = await captureSnapshot(new Date("2026-04-23T10:00:00Z"));
    expect(result.errors.map((e) => e.pair)).toContain("USD/XAF");
  });
});

describe("valueAtTime", () => {
  beforeEach(() => {
    rows.length = 0;
    idSeq = 1;
    axiosMock.get.mockReset();
    process.env.EXCHANGE_RATE_API_KEY = "test-key";
  });

  it("returns identity conversion for base === quote with lag 0", async () => {
    const at = new Date("2026-04-23T10:00:00Z");
    const r = await valueAtTime("USD", "USD", 100, at);
    expect(r).not.toBeNull();
    expect(r!.price).toBe(1);
    expect(r!.convertedAmount).toBe(100);
    expect(r!.priceSource).toBe("identity");
    expect(r!.lagSeconds).toBe(0);
  });

  it("returns null when no snapshot exists at or before the timestamp", async () => {
    const r = await valueAtTime(
      "XLM",
      "USD",
      1,
      new Date("2026-04-23T10:00:00Z"),
    );
    expect(r).toBeNull();
  });

  it("uses the nearest snapshot recorded <= queriedAt", async () => {
    mockCoinGeckoOnce(0.1);
    mockExchangeRateOnce(600);
    await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    mockCoinGeckoOnce(0.12);
    mockExchangeRateOnce(610);
    await captureSnapshot(new Date("2026-04-23T12:00:00Z"));

    // Query at 13:30 — should pick the 12:00 snapshot.
    const r = await valueAtTime(
      "XLM",
      "USD",
      100,
      new Date("2026-04-23T13:30:00Z"),
    );
    expect(r).not.toBeNull();
    expect(r!.price).toBe(0.12);
    expect(r!.convertedAmount).toBeCloseTo(12);
    expect(r!.priceRecordedAt.toISOString()).toBe("2026-04-23T12:00:00.000Z");
    expect(r!.lagSeconds).toBe(90 * 60); // 1.5 hours
  });

  it("multiplies amount by the snapshot price", async () => {
    mockCoinGeckoOnce(0.2);
    mockExchangeRateOnce(650);
    await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    const r = await valueAtTime(
      "XLM",
      "XAF",
      50,
      new Date("2026-04-23T10:30:00Z"),
    );
    expect(r).not.toBeNull();
    expect(r!.convertedAmount).toBeCloseTo(50 * 0.2 * 650, 4);
  });
});

describe("findNearest / findLatest / findRange integration", () => {
  beforeEach(() => {
    rows.length = 0;
    idSeq = 1;
    axiosMock.get.mockReset();
    process.env.EXCHANGE_RATE_API_KEY = "test-key";
  });

  it("findLatest returns the most recent snapshot for a pair", async () => {
    mockCoinGeckoOnce(0.1);
    mockExchangeRateOnce(600);
    await captureSnapshot(new Date("2026-04-23T08:00:00Z"));
    mockCoinGeckoOnce(0.11);
    mockExchangeRateOnce(605);
    await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    const latest = await findLatest("XLM", "USD");
    expect(latest!.price).toBe(0.11);
    expect(latest!.recordedAt.toISOString()).toBe("2026-04-23T10:00:00.000Z");
  });

  it("findNearest ignores snapshots strictly after the query time", async () => {
    mockCoinGeckoOnce(0.1);
    mockExchangeRateOnce(600);
    await captureSnapshot(new Date("2026-04-23T10:00:00Z"));

    const r = await findNearest("XLM", "USD", new Date("2026-04-23T09:00:00Z"));
    expect(r).toBeNull();
  });

  it("findRange returns snapshots in chronological order", async () => {
    for (let h = 8; h <= 12; h++) {
      mockCoinGeckoOnce(0.1 + h * 0.01);
      mockExchangeRateOnce(600);
      await captureSnapshot(
        new Date(`2026-04-23T${String(h).padStart(2, "0")}:00:00Z`),
      );
    }

    const range = await findRange(
      "XLM",
      "USD",
      new Date("2026-04-23T09:00:00Z"),
      new Date("2026-04-23T11:00:00Z"),
    );
    expect(range).toHaveLength(3);
    const times = range.map((r) => r.recordedAt.toISOString());
    expect(times).toEqual([
      "2026-04-23T09:00:00.000Z",
      "2026-04-23T10:00:00.000Z",
      "2026-04-23T11:00:00.000Z",
    ]);
  });
});
