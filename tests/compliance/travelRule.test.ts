import {
  TravelRuleService,
  TRAVEL_RULE_THRESHOLD_USD,
  TravelRuleInput,
} from "../../src/compliance/travelRule";

// Mock the database pool
jest.mock("../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

// Mock encryption so tests are deterministic
jest.mock("../../src/utils/encryption", () => ({
  encrypt: (v: string | null | undefined) => (v ? `enc:${v}` : v),
  decrypt: (v: string | null | undefined) => {
    if (!v) return v;
    return v.startsWith("enc:") ? v.slice(4) : v;
  },
}));

import { pool } from "../../src/config/database";

const mockQuery = pool.query as jest.Mock;

const baseInput: TravelRuleInput = {
  transactionId: "tx-abc-123",
  amount: 1500,
  currency: "USD",
  sender: {
    name: "Alice Smith",
    account: "+237670000001",
    address: "123 Main St",
    dob: "1990-01-15",
    idNumber: "ID-9876",
  },
  receiver: {
    name: "Bob Jones",
    account: "GBXXX123STELLAR",
    address: "456 Oak Ave",
  },
  originatingVasp: "MTN",
  beneficiaryVasp: "StellarNet",
};

describe("TravelRuleService", () => {
  let service: TravelRuleService;

  beforeEach(() => {
    service = new TravelRuleService();
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // applies()
  // ---------------------------------------------------------------------------
  describe("applies()", () => {
    it("returns true at the threshold", () => {
      expect(service.applies(TRAVEL_RULE_THRESHOLD_USD)).toBe(true);
    });

    it("returns true above the threshold", () => {
      expect(service.applies(5000)).toBe(true);
    });

    it("returns false below the threshold", () => {
      expect(service.applies(999.99)).toBe(false);
    });

    it("returns false for zero", () => {
      expect(service.applies(0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // capture()
  // ---------------------------------------------------------------------------
  describe("capture()", () => {
    it("inserts an encrypted record and returns it", async () => {
      const fakeRow = {
        id: "rec-001",
        created_at: new Date("2026-04-23T10:00:00Z"),
      };
      mockQuery.mockResolvedValueOnce({ rows: [fakeRow] });

      const result = await service.capture(baseInput);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO travel_rule_records");

      // Encrypted values should be prefixed with "enc:"
      expect(params[3]).toBe("enc:Alice Smith"); // sender_name
      expect(params[4]).toBe("enc:+237670000001"); // sender_account
      expect(params[8]).toBe("enc:Bob Jones"); // receiver_name

      expect(result.id).toBe("rec-001");
      expect(result.transactionId).toBe("tx-abc-123");
      expect(result.amount).toBe(1500);
      expect(result.sender.name).toBe("Alice Smith");
      expect(result.receiver.account).toBe("GBXXX123STELLAR");
    });

    it("handles optional sender fields being undefined", async () => {
      const fakeRow = { id: "rec-002", created_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [fakeRow] });

      const minimalInput: TravelRuleInput = {
        transactionId: "tx-min",
        amount: 2000,
        sender: { name: "Min Sender", account: "acc-001" },
        receiver: { name: "Min Receiver", account: "acc-002" },
      };

      const result = await service.capture(minimalInput);

      const [, params] = mockQuery.mock.calls[0];
      expect(params[5]).toBeNull(); // sender_address
      expect(params[6]).toBeNull(); // sender_dob
      expect(params[7]).toBeNull(); // sender_id_number
      expect(result.currency).toBe("USD"); // default currency
    });
  });

  // ---------------------------------------------------------------------------
  // findByTransactionId()
  // ---------------------------------------------------------------------------
  describe("findByTransactionId()", () => {
    it("returns null when no record exists", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await service.findByTransactionId("tx-missing");
      expect(result).toBeNull();
    });

    it("returns a decrypted record when found", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "rec-003",
            transaction_id: "tx-found",
            amount: "1500.0000000",
            currency: "USD",
            sender_name: "enc:Alice Smith",
            sender_account: "enc:+237670000001",
            sender_address: "enc:123 Main St",
            sender_dob: "enc:1990-01-15",
            sender_id_number: "enc:ID-9876",
            receiver_name: "enc:Bob Jones",
            receiver_account: "enc:GBXXX123STELLAR",
            receiver_address: null,
            originating_vasp: "MTN",
            beneficiary_vasp: null,
            created_at: new Date("2026-04-23T10:00:00Z"),
            exported_at: null,
            exported_by: null,
          },
        ],
      });

      const result = await service.findByTransactionId("tx-found");

      expect(result).not.toBeNull();
      expect(result!.sender.name).toBe("Alice Smith");
      expect(result!.sender.dob).toBe("1990-01-15");
      expect(result!.receiver.name).toBe("Bob Jones");
      expect(result!.receiver.address).toBeUndefined();
      expect(result!.originatingVasp).toBe("MTN");
    });
  });

  // ---------------------------------------------------------------------------
  // exportForCompliance()
  // ---------------------------------------------------------------------------
  describe("exportForCompliance()", () => {
    const mockRows = [
      {
        id: "rec-004",
        transaction_id: "tx-export-1",
        amount: "2000.0000000",
        currency: "USD",
        sender_name: "enc:Export Sender",
        sender_account: "enc:+237670000002",
        sender_address: null,
        sender_dob: null,
        sender_id_number: null,
        receiver_name: "enc:Export Receiver",
        receiver_account: "enc:GBYYY456STELLAR",
        receiver_address: null,
        originating_vasp: "Airtel",
        beneficiary_vasp: null,
        created_at: new Date("2026-04-20T08:00:00Z"),
        exported_at: null,
        exported_by: null,
      },
    ];

    it("returns decrypted records and marks them exported", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: mockRows }) // SELECT
        .mockResolvedValueOnce({ rows: [] }); // UPDATE

      const results = await service.exportForCompliance({
        exportedBy: "officer-1",
      });

      expect(results).toHaveLength(1);
      expect(results[0].sender.name).toBe("Export Sender");
      expect(results[0].transactionId).toBe("tx-export-1");

      // Should have called UPDATE to mark exported
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const updateCall = mockQuery.mock.calls[1][0];
      expect(updateCall).toContain("UPDATE travel_rule_records");
      expect(updateCall).toContain("exported_at = NOW()");
    });

    it("skips the UPDATE when no records are found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const results = await service.exportForCompliance({
        exportedBy: "officer-2",
      });

      expect(results).toHaveLength(0);
      expect(mockQuery).toHaveBeenCalledTimes(1); // only SELECT
    });

    it("applies onlyUnexported filter", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await service.exportForCompliance({
        exportedBy: "officer-3",
        onlyUnexported: true,
      });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("exported_at IS NULL");
    });

    it("uses provided from/to dates", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const from = new Date("2026-01-01");
      const to = new Date("2026-03-31");
      await service.exportForCompliance({ exportedBy: "officer-4", from, to });

      const [, params] = mockQuery.mock.calls[0];
      expect(params[0]).toBe(from);
      expect(params[1]).toBe(to);
    });
  });
});
