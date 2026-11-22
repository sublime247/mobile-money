const mockQuery = jest.fn();

jest.mock("../../config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}));

import {
  AmlScreeningService,
  PENDING_COMPLIANCE_REVIEW,
  levenshteinDistance,
  nameSimilarityScore,
  normalizeName,
} from "../amlScreening";

const pepScreener = {
  screenCustomer: jest.fn().mockResolvedValue({ matched: false, score: 0, matches: [] }),
};

describe("normalizeName", () => {
  it("strips diacritics, punctuation, honorifics and suffixes", () => {
    expect(normalizeName("  José   O'Neil-Smith, Jr. ")).toBe("jose o neil smith");
    expect(normalizeName("Mr. Osama BIN LADEN")).toBe("osama bin laden");
    expect(normalizeName(undefined)).toBe("");
  });
});

describe("fuzzy matching", () => {
  it("computes Levenshtein distance", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("same", "same")).toBe(0);
  });

  it("scores identical and near-identical names highly", () => {
    expect(nameSimilarityScore("John Doe", "john doe")).toBe(1);
    expect(nameSimilarityScore("Mohamed Ali", "Mohammed Ali")).toBeGreaterThan(0.75);
    expect(nameSimilarityScore("Osama bin Laden", "Osama Bin Ladin")).toBeGreaterThan(0.8);
  });

  it("scores unrelated names low", () => {
    expect(nameSimilarityScore("John Doe", "Acme Widgets Inc")).toBeLessThan(0.5);
  });
});

describe("AmlScreeningService", () => {
  let service: AmlScreeningService;

  beforeEach(() => {
    mockQuery.mockReset();
    pepScreener.screenCustomer.mockReset();
    pepScreener.screenCustomer.mockResolvedValue({ matched: false, score: 0, matches: [] });

    mockQuery.mockImplementation((query: unknown) => {
      if (typeof query === "string" && query.includes("FROM transactions")) {
        return Promise.resolve({ rows: [{ total: "0" }] });
      }
      // Empty sanctions table -> service falls back to its seed list.
      return Promise.resolve({ rows: [] });
    });

    service = new AmlScreeningService({ highVolumeThresholdUsd: 1000 }, pepScreener);
    service.reset();
  });

  it("uses the documented $1,000 daily volume threshold", () => {
    expect(service.getConfig().highVolumeThresholdUsd).toBe(1000);
    expect(service.isHighVolume(1000)).toBe(true);
    expect(service.isHighVolume(999.99)).toBe(false);
    expect(service.isHighVolume(Number.NaN)).toBe(false);
  });

  it("loads sanctions from the database when rows exist", async () => {
    mockQuery.mockImplementationOnce(() =>
      Promise.resolve({
        rows: [
          { name: "Mr Bad Actor", source: "OFAC", category: "Individual" },
        ],
      }),
    );

    const entities = await service.loadSanctions(true);
    expect(entities).toHaveLength(1);
    expect(entities[0].source).toBe("OFAC");
  });

  it("falls back to seed sanctions when the table is empty", async () => {
    const entities = await service.loadSanctions(true);
    expect(entities.some((e) => e.source === "OFAC")).toBe(true);
    expect(entities.some((e) => e.source === "UN")).toBe(true);
    expect(entities.some((e) => e.source === "EU")).toBe(true);
  });

  it("skips screening below the volume threshold", async () => {
    const result = await service.screenParties({
      transactionId: "txn-1",
      senderName: "Global Arms Ltd",
      receiverName: "Jane Smith",
      dailyVolumeUsd: 500,
    });

    expect(result.required).toBe(false);
    expect(result.flagged).toBe(false);
    expect(result.status).toBe("passed");
    expect(result.matches).toHaveLength(0);
    expect(result.auditRecordIds).toHaveLength(0);
  });

  it("flags a high-volume sender matching the sanctions list", async () => {
    const result = await service.screenParties({
      transactionId: "txn-1",
      userId: "user-1",
      senderName: "Global Arms Ltd",
      receiverName: "Alice Johnson",
      dailyVolumeUsd: 25_000,
    });

    expect(result.required).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.status).toBe(PENDING_COMPLIANCE_REVIEW);
    expect(result.matches[0]).toMatchObject({
      party: "sender",
      listType: "sanctions",
      matchedName: "Global Arms Ltd",
      source: "OFAC",
    });
    expect(result.auditRecordIds).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO aml_screening_audit"),
      expect.any(Array),
    );
  });

  it("flags a high-volume receiver matching the sanctions list", async () => {
    const result = await service.screenParties({
      transactionId: "txn-2",
      senderName: "Alice Johnson",
      receiverName: "Osama Bin Laden",
      dailyVolumeUsd: 10_000,
    });

    expect(result.flagged).toBe(true);
    expect(result.matches.some((m) => m.party === "receiver")).toBe(true);
  });

  it("flags a PEP match returned by the PEP screener", async () => {
    pepScreener.screenCustomer.mockResolvedValueOnce({
      matched: true,
      score: 0.92,
      matches: [
        {
          record: {
            fullName: "Maria Santos",
            source: "WorldBank",
            position: "Former President",
          },
          score: 0.92,
        },
      ],
    });

    const result = await service.screenParties({
      transactionId: "txn-3",
      senderName: "Maria Santos",
      dailyVolumeUsd: 5_000,
    });

    expect(result.flagged).toBe(true);
    expect(result.matches[0]).toMatchObject({
      listType: "pep",
      matchedName: "Maria Santos",
      source: "WorldBank",
    });
  });

  it("can evaluate without persisting the audit records", async () => {
    const result = await service.screenParties(
      {
        transactionId: "txn-4",
        senderName: "Global Arms Ltd",
        dailyVolumeUsd: 5_000,
      },
      { persistAudit: false },
    );

    expect(result.flagged).toBe(true);
    expect(result.auditRecordIds).toHaveLength(0);
    const insertCalls = mockQuery.mock.calls.filter(([q]: [string]) =>
      typeof q === "string" && q.includes("INSERT INTO aml_screening_audit"),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("builds an immutable, verifiable audit hash chain", async () => {
    await service.recordScreeningAudit({
      transactionId: "txn-a",
      party: "sender",
      listType: "sanctions",
      screenedName: "Bad Actor",
      matchedName: "Bad Actor",
      score: 0.99,
      source: "OFAC",
      dailyVolumeUsd: 2000,
      status: PENDING_COMPLIANCE_REVIEW,
    });
    await service.recordScreeningAudit({
      transactionId: "txn-b",
      party: "receiver",
      listType: "pep",
      screenedName: "Maria Santos",
      matchedName: "Maria Santos",
      score: 0.92,
      source: "WorldBank",
      dailyVolumeUsd: 3000,
      status: PENDING_COMPLIANCE_REVIEW,
    });

    const trail = service.getAuditTrail();
    expect(trail).toHaveLength(2);
    expect(trail[0].previousHash).toBe("GENESIS");
    expect(trail[1].previousHash).toBe(trail[0].recordHash);
    expect(service.verifyAuditTrail()).toBe(true);

    // getAuditTrail returns copies: mutating them must not affect the chain.
    trail[1].matchedName = "Someone Else";
    expect(service.verifyAuditTrail()).toBe(true);

    // Mutating the internal append-only trail breaks chain verification.
    const internal = (service as unknown as {
      auditTrail: Array<{ matchedName: string }>;
    }).auditTrail;
    internal[1].matchedName = "Someone Else";
    expect(service.verifyAuditTrail()).toBe(false);
  });

  it("computes daily volume from the transactions table and adds the amount", async () => {
    mockQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ total: "900.00" }] }),
    );

    const result = await service.screenSep31Transaction({
      transactionId: "txn-5",
      userId: "user-1",
      senderName: "Global Arms Ltd",
      amountUsd: 250,
    });

    expect(result.dailyVolumeUsd).toBe(1150);
    expect(result.flagged).toBe(true);
  });

  it("defaults daily volume to 0 when the aggregate query fails", async () => {
    mockQuery.mockImplementationOnce(() =>
      Promise.reject(new Error("db down")),
    );

    await expect(service.getDailyVolumeUsd("user-1")).resolves.toBe(0);
  });
});
