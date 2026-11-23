import {
  generatePaymentDedupJobId,
  getTimestampWindowBucket,
  DEDUP_WINDOW_MS,
} from "../jobUtils";

describe("getTimestampWindowBucket", () => {
  // Aligned to a window boundary so offsets within [0, DEDUP_WINDOW_MS) are
  // guaranteed to land in the same bucket, and +DEDUP_WINDOW_MS in the next.
  const windowStart =
    Math.floor(1_700_000_000_000 / DEDUP_WINDOW_MS) * DEDUP_WINDOW_MS;

  it("buckets timestamps within the same window to the same value", () => {
    expect(getTimestampWindowBucket(windowStart)).toBe(
      getTimestampWindowBucket(windowStart + DEDUP_WINDOW_MS - 1),
    );
  });

  it("buckets timestamps in different windows to different values", () => {
    expect(getTimestampWindowBucket(windowStart)).not.toBe(
      getTimestampWindowBucket(windowStart + DEDUP_WINDOW_MS),
    );
  });
});

describe("generatePaymentDedupJobId", () => {
  const baseAttrs = {
    sender: "G_SENDER",
    recipient: "+233200000000",
    amount: "100.00",
    currency: "GHS",
  };

  it("is deterministic for identical attributes in the same window", () => {
    const timestamp = 1_700_000_000_001;
    const first = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    const second = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    expect(first).toBe(second);
  });

  it("is the same across different instants within one 60s window", () => {
    const windowStart =
      Math.floor(Date.now() / DEDUP_WINDOW_MS) * DEDUP_WINDOW_MS;
    const idAtStart = generatePaymentDedupJobId({
      ...baseAttrs,
      timestamp: windowStart,
    });
    const idNearEnd = generatePaymentDedupJobId({
      ...baseAttrs,
      timestamp: windowStart + DEDUP_WINDOW_MS - 1,
    });
    expect(idAtStart).toBe(idNearEnd);
  });

  it("differs for the same transfer attributes in a later window", () => {
    const timestamp = 1_700_000_000_000;
    const first = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    const second = generatePaymentDedupJobId({
      ...baseAttrs,
      timestamp: timestamp + DEDUP_WINDOW_MS,
    });
    expect(first).not.toBe(second);
  });

  it("differs when the sender differs", () => {
    const timestamp = 1_700_000_000_000;
    const first = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    const second = generatePaymentDedupJobId({
      ...baseAttrs,
      sender: "G_OTHER_SENDER",
      timestamp,
    });
    expect(first).not.toBe(second);
  });

  it("differs when the recipient differs", () => {
    const timestamp = 1_700_000_000_000;
    const first = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    const second = generatePaymentDedupJobId({
      ...baseAttrs,
      recipient: "+233200000001",
      timestamp,
    });
    expect(first).not.toBe(second);
  });

  it("differs when the amount differs", () => {
    const timestamp = 1_700_000_000_000;
    const first = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    const second = generatePaymentDedupJobId({
      ...baseAttrs,
      amount: "100.01",
      timestamp,
    });
    expect(first).not.toBe(second);
  });

  it("differs when the currency differs", () => {
    const timestamp = 1_700_000_000_000;
    const first = generatePaymentDedupJobId({ ...baseAttrs, timestamp });
    const second = generatePaymentDedupJobId({
      ...baseAttrs,
      currency: "NGN",
      timestamp,
    });
    expect(first).not.toBe(second);
  });

  it("treats numeric and string amounts with the same value identically", () => {
    const timestamp = 1_700_000_000_000;
    const first = generatePaymentDedupJobId({
      ...baseAttrs,
      amount: 100,
      timestamp,
    });
    const second = generatePaymentDedupJobId({
      ...baseAttrs,
      amount: "100",
      timestamp,
    });
    expect(first).toBe(second);
  });

  it("defaults to the current time when no timestamp is given", () => {
    const before = Date.now();
    const id = generatePaymentDedupJobId(baseAttrs);
    const after = Date.now();
    const expectedBucket = getTimestampWindowBucket(before);
    const expectedBucketAfter = getTimestampWindowBucket(after);
    // Sanity: the id should match generating with a timestamp from the same
    // window (covers the (rare) case the window rolled over mid-test).
    const matchesStart =
      id === generatePaymentDedupJobId({ ...baseAttrs, timestamp: before });
    const matchesEnd =
      id === generatePaymentDedupJobId({ ...baseAttrs, timestamp: after });
    expect(matchesStart || matchesEnd).toBe(true);
    expect(expectedBucket).toBeLessThanOrEqual(expectedBucketAfter);
  });

  it("returns a stable, queue-safe string prefix", () => {
    const id = generatePaymentDedupJobId({
      ...baseAttrs,
      timestamp: 1_700_000_000_000,
    });
    expect(id).toMatch(/^payment-dedup-[0-9a-f]{64}$/);
  });
});
