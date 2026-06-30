let mockTransactions: any[] = [];
let mockDisputes: any[] = [];
let mockDisputeNotes: any[] = [];

jest.mock("../config/database", () => ({
  queryWrite: jest.fn(async (text: string, params?: any[]) => {
    if (text.includes("INSERT INTO transactions")) {
      const [
        id,
        reference_number,
        type,
        amount,
        phone_number,
        provider,
        stellar_address,
        status,
      ] = params!;
      mockTransactions.push({
        id,
        reference_number,
        type,
        amount,
        phone_number,
        provider,
        stellar_address,
        status,
      });
    } else if (text.includes("INSERT INTO disputes")) {
      const [id, transaction_id, reason, status, priority] = params!;
      mockDisputes.push({
        id,
        transaction_id,
        reason,
        status,
        priority,
        created_at: new Date(),
        sla_due_date: null,
      });
    } else if (
      text.includes(
        "UPDATE disputes SET created_at = NOW() - INTERVAL '5 hours'",
      )
    ) {
      const [id] = params!;
      const d = mockDisputes.find((x) => x.id === id);
      if (d) {
        d.created_at = new Date(Date.now() - 5 * 60 * 60 * 1000);
        d.sla_due_date = null;
      }
    } else if (text.includes("UPDATE disputes SET sla_due_date = $1")) {
      const [slaDueDate, id] = params!;
      const d = mockDisputes.find((x) => x.id === id);
      if (d) {
        d.sla_due_date = slaDueDate;
      }
    } else if (text.includes("UPDATE disputes SET status = 'resolved'")) {
      const [resolution, id] = params!;
      const d = mockDisputes.find((x) => x.id === id);
      if (d) {
        d.status = "resolved";
        d.resolution = resolution;
        d.updated_at = new Date();
      }
    } else if (text.includes("INSERT INTO dispute_notes")) {
      const [dispute_id, author, note] = params!;
      mockDisputeNotes.push({
        dispute_id,
        author,
        note,
        created_at: new Date(),
      });
    }
    return { rows: [], rowCount: 1 };
  }),
  queryRead: jest.fn(async (text: string, params?: any[]) => {
    if (
      text.includes(
        'SELECT id, priority, created_at AS "createdAt" FROM disputes WHERE sla_due_date IS NULL',
      )
    ) {
      const res = mockDisputes
        .filter((d) => d.sla_due_date === null)
        .map((d) => ({
          id: d.id,
          priority: d.priority,
          createdAt: d.created_at,
        }));
      return { rows: res };
    } else if (
      text.includes("status IN ('open', 'investigating')") &&
      text.includes("sla_due_date < NOW()")
    ) {
      const res = mockDisputes
        .filter(
          (d) =>
            ["open", "investigating"].includes(d.status) &&
            d.sla_due_date !== null &&
            new Date(d.sla_due_date) < new Date(),
        )
        .map((d) => ({ id: d.id, transactionId: d.transaction_id }));
      return { rows: res };
    } else if (
      text.includes('SELECT provider, phone_number AS "phoneNumber"')
    ) {
      const [id] = params!;
      const tx = mockTransactions.find((t) => t.id === id);
      return {
        rows: tx
          ? [
              {
                provider: tx.provider,
                phoneNumber: tx.phone_number,
                amount: String(tx.amount),
              },
            ]
          : [],
      };
    } else if (
      text.includes("SELECT status, resolution, sla_due_date FROM disputes")
    ) {
      const [id] = params!;
      const d = mockDisputes.find((x) => x.id === id);
      return {
        rows: d
          ? [
              {
                status: d.status,
                resolution: d.resolution,
                sla_due_date: d.sla_due_date,
              },
            ]
          : [],
      };
    } else if (text.includes("SELECT author FROM dispute_notes")) {
      const [id] = params!;
      return {
        rows: mockDisputeNotes.filter((n) => n.dispute_id === id),
      };
    }
    return { rows: [] };
  }),
}));

jest.mock("../services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({
    sendPayout: jest.fn().mockResolvedValue({
      success: true,
      data: { transactionId: "mock-payout-tx-id" },
    }),
  })),
}));

import { DisputeStateMachine } from "../services/disputeStateMachine";
import { validateDisputeEvidenceFile } from "../services/disputeS3Upload";
import {
  generateUniqueFilename,
  generateDisputeS3Key,
} from "../middleware/disputeUpload";
import { DisputeModel } from "../models/dispute";

describe("Advanced Dispute Resolution", () => {
  describe("DisputeStateMachine", () => {
    let stateMachine: DisputeStateMachine;

    beforeEach(() => {
      stateMachine = new DisputeStateMachine();
    });

    test("should validate valid state transitions", () => {
      expect(stateMachine.isValidTransition("open", "investigating")).toBe(
        true,
      );
      expect(stateMachine.isValidTransition("open", "resolved")).toBe(true);
      expect(stateMachine.isValidTransition("open", "reversed")).toBe(true);
      expect(stateMachine.isValidTransition("open", "upheld")).toBe(true);
      expect(stateMachine.isValidTransition("investigating", "resolved")).toBe(
        true,
      );
      expect(stateMachine.isValidTransition("investigating", "rejected")).toBe(
        true,
      );
      expect(stateMachine.isValidTransition("investigating", "reversed")).toBe(
        true,
      );
      expect(stateMachine.isValidTransition("investigating", "upheld")).toBe(
        true,
      );
    });

    test("should reject invalid state transitions", () => {
      expect(stateMachine.isValidTransition("resolved", "investigating")).toBe(
        false,
      );
      expect(stateMachine.isValidTransition("rejected", "open")).toBe(false);
      expect(stateMachine.isValidTransition("open", "open")).toBe(false);
    });

    test("should identify terminal states", () => {
      expect(stateMachine.isTerminalState("resolved")).toBe(true);
      expect(stateMachine.isTerminalState("rejected")).toBe(true);
      expect(stateMachine.isTerminalState("reversed")).toBe(true);
      expect(stateMachine.isTerminalState("upheld")).toBe(true);
      expect(stateMachine.isTerminalState("open")).toBe(false);
      expect(stateMachine.isTerminalState("investigating")).toBe(false);
    });

    test("should validate transition requirements", () => {
      const validation = stateMachine.validateTransition("open", "resolved", {
        resolution: "Issue resolved",
      });
      expect(validation.valid).toBe(true);

      const invalidValidation = stateMachine.validateTransition(
        "open",
        "resolved",
        {},
      );
      expect(invalidValidation.valid).toBe(false);
      expect(invalidValidation.errors).toContain(
        'Field "resolution" is required for transition to "resolved"',
      );
    });

    test("should calculate correct SLA hours", () => {
      expect(stateMachine.getSlaHours("critical")).toBe(4);
      expect(stateMachine.getSlaHours("high")).toBe(24);
      expect(stateMachine.getSlaHours("medium")).toBe(72);
      expect(stateMachine.getSlaHours("low")).toBe(168);
    });

    test("should detect overdue disputes", () => {
      const pastDate = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
      expect(stateMachine.isOverdue(pastDate, "critical")).toBe(true);
      expect(stateMachine.isOverdue(pastDate, "high")).toBe(false);
    });

    test("should recommend next states", () => {
      expect(
        stateMachine.getRecommendedNextState("open", {
          hasAssignee: true,
          priority: "high",
        }),
      ).toBe("investigating");

      expect(
        stateMachine.getRecommendedNextState("investigating", {
          hasEvidence: true,
          daysSinceCreated: 2,
        }),
      ).toBe("resolved");

      expect(stateMachine.getRecommendedNextState("resolved", {})).toBeNull();
      expect(stateMachine.getRecommendedNextState("reversed", {})).toBeNull();
      expect(stateMachine.getRecommendedNextState("upheld", {})).toBeNull();
    });
  });

  describe("Dispute Priority and SLA", () => {
    test("should handle priority-based SLA calculation", () => {
      const priorities = ["critical", "high", "medium", "low"] as const;
      const expectedHours = [4, 24, 72, 168];

      priorities.forEach((priority, index) => {
        const sm = new DisputeStateMachine();
        expect(sm.getSlaHours(priority)).toBe(expectedHours[index]);
      });
    });

    test("should calculate time until SLA deadline", () => {
      const sm = new DisputeStateMachine();
      const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      const result = sm.getTimeUntilSlaDeadline(createdAt, "critical");
      expect(result.hours).toBe(2); // 4 hour SLA - 2 hours elapsed = 2 hours remaining
      expect(result.isOverdue).toBe(false);

      const overdueResult = sm.getTimeUntilSlaDeadline(createdAt, "critical");
      expect(overdueResult.hours).toBeGreaterThan(0);
    });
  });

  describe("Evidence File Validation", () => {
    test("should validate allowed file types", () => {
      const validFile = {
        originalname: "receipt.pdf",
        mimetype: "application/pdf",
        size: 1024 * 1024, // 1MB
      } as Express.Multer.File;

      const result = validateDisputeEvidenceFile(validFile);
      expect(result.valid).toBe(true);
    });

    test("should reject invalid file types", () => {
      const invalidFile = {
        originalname: "malware.exe",
        mimetype: "application/x-executable",
        size: 1024,
      } as Express.Multer.File;

      const result = validateDisputeEvidenceFile(invalidFile);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid file type");
    });

    test("should reject oversized files", () => {
      const oversizedFile = {
        originalname: "large.pdf",
        mimetype: "application/pdf",
        size: 15 * 1024 * 1024, // 15MB (over 10MB limit)
      } as Express.Multer.File;

      const result = validateDisputeEvidenceFile(oversizedFile);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum limit");
    });
  });

  describe("Filename Generation", () => {
    test("should generate unique filenames", () => {
      const filename1 = generateUniqueFilename("receipt.pdf");
      const filename2 = generateUniqueFilename("receipt.pdf");

      expect(filename1).not.toBe(filename2);
      expect(filename1).toMatch(/receipt-\d+-[a-f0-9]+\.pdf/);
      expect(filename2).toMatch(/receipt-\d+-[a-f0-9]+\.pdf/);
    });

    test("should sanitize filenames", () => {
      const filename = generateUniqueFilename(
        "my file with spaces & symbols!.pdf",
      );
      expect(filename).toMatch(
        /my_file_with_spaces___symbols_-\d+-[a-f0-9]+\.pdf/,
      );
    });
  });

  describe("S3 Key Generation", () => {
    test("should generate proper S3 keys", () => {
      const disputeId = "dispute-123";
      const filename = "receipt-123-abc.pdf";

      const key = generateDisputeS3Key(disputeId, filename);

      expect(key).toMatch(
        /^dispute-evidence\/\d{4}\/\d{2}\/dispute-123\/receipt-123-abc\.pdf$/,
      );
    });
  });
});

import { checkSlaDeadlines } from "../services/disputeStateMachine";
import { queryWrite, queryRead } from "../config/database";

describe("Dispute Model Integration and SLA Resolution Engine", () => {
  test("should set SLA timelocks and auto-resolve overdue disputes with payout", async () => {
    // Setup a fake transaction
    const txId = "00000000-0000-0000-0000-000000000002";
    await queryWrite(
      `INSERT INTO transactions (id, reference_number, type, amount, phone_number, provider, stellar_address, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        txId,
        "TXN-REF-SLA",
        "deposit",
        200,
        "+237600000000",
        "mock",
        "GA",
        "completed",
      ],
    );

    // Setup an untimelocked dispute (sla_due_date IS NULL)
    const disputeId = "00000000-0000-0000-0000-000000000003";
    await queryWrite(
      `INSERT INTO disputes (id, transaction_id, reason, status, priority)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [disputeId, txId, "SLA test", "open", "critical"],
    );

    // Force created_at to 5 hours ago so it becomes overdue (critical SLA is 4 hours)
    await queryWrite(
      `UPDATE disputes SET created_at = NOW() - INTERVAL '5 hours', sla_due_date = NULL WHERE id = $1`,
      [disputeId],
    );

    // Run checkSlaDeadlines - this should first set the SLA timelock, then auto-resolve it!
    await checkSlaDeadlines();

    // Verify it set the SLA timelock and auto-resolved the dispute
    const disputeResult = await queryRead<any>(
      `SELECT status, resolution, sla_due_date FROM disputes WHERE id = $1`,
      [disputeId],
    );
    const dispute = disputeResult.rows[0];

    expect(dispute.status).toBe("resolved");
    expect(dispute.resolution).toContain("SLA deadline expired");
    expect(dispute.sla_due_date).not.toBeNull();

    // Verify system notes were added
    const notesResult = await queryRead<any>(
      `SELECT author FROM dispute_notes WHERE dispute_id = $1`,
      [disputeId],
    );
    expect(notesResult.rows.length).toBeGreaterThan(0);
    expect(notesResult.rows[0].author).toBe("system");
  });
});
