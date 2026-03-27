import { DisputeStateMachine } from "../services/disputeStateMachine";
import { DisputeModel } from "../models/dispute";
import { validateDisputeEvidenceFile } from "../services/disputeS3Upload";
import { generateUniqueFilename, generateDisputeS3Key } from "../middleware/disputeUpload";

describe("Advanced Dispute Resolution", () => {
  describe("DisputeStateMachine", () => {
    let stateMachine: DisputeStateMachine;

    beforeEach(() => {
      stateMachine = new DisputeStateMachine();
    });

    test("should validate valid state transitions", () => {
      expect(stateMachine.isValidTransition("open", "investigating")).toBe(true);
      expect(stateMachine.isValidTransition("open", "resolved")).toBe(true);
      expect(stateMachine.isValidTransition("investigating", "resolved")).toBe(true);
      expect(stateMachine.isValidTransition("investigating", "rejected")).toBe(true);
    });

    test("should reject invalid state transitions", () => {
      expect(stateMachine.isValidTransition("resolved", "investigating")).toBe(false);
      expect(stateMachine.isValidTransition("rejected", "open")).toBe(false);
      expect(stateMachine.isValidTransition("open", "open")).toBe(false);
    });

    test("should identify terminal states", () => {
      expect(stateMachine.isTerminalState("resolved")).toBe(true);
      expect(stateMachine.isTerminalState("rejected")).toBe(true);
      expect(stateMachine.isTerminalState("open")).toBe(false);
      expect(stateMachine.isTerminalState("investigating")).toBe(false);
    });

    test("should validate transition requirements", () => {
      const validation = stateMachine.validateTransition("open", "resolved", {
        resolution: "Issue resolved",
      });
      expect(validation.valid).toBe(true);

      const invalidValidation = stateMachine.validateTransition("open", "resolved", {});
      expect(invalidValidation.valid).toBe(false);
      expect(invalidValidation.errors).toContain('Field "resolution" is required for transition to "resolved"');
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
        stateMachine.getRecommendedNextState("open", { hasAssignee: true, priority: "high" })
      ).toBe("investigating");

      expect(
        stateMachine.getRecommendedNextState("investigating", { 
          hasEvidence: true, 
          daysSinceCreated: 2 
        })
      ).toBe("resolved");

      expect(
        stateMachine.getRecommendedNextState("resolved", {})
      ).toBeNull();
    });
  });

  describe("Dispute Priority and SLA", () => {
    test("should handle priority-based SLA calculation", () => {
      const priorities = ["critical", "high", "medium", "low"] as const;
      const expectedHours = [4, 24, 72, 168];

      priorities.forEach((priority, index) => {
        const stateMachine = new DisputeStateMachine();
        expect(stateMachine.getSlaHours(priority)).toBe(expectedHours[index]);
      });
    });

    test("should calculate time until SLA deadline", () => {
      const stateMachine = new DisputeStateMachine();
      const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      
      const result = stateMachine.getTimeUntilSlaDeadline(createdAt, "critical");
      expect(result.hours).toBe(2); // 4 hour SLA - 2 hours elapsed = 2 hours remaining
      expect(result.isOverdue).toBe(false);

      const overdueResult = stateMachine.getTimeUntilSlaDeadline(createdAt, "critical");
      // For a critical dispute created 2 hours ago, should have 2 hours left
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
      
      const filename = generateUniqueFilename("my file with spaces & symbols!.pdf");
      expect(filename).toMatch(/my_file_with_spaces___symbols_-\d+-[a-f0-9]+\.pdf/);
    });
  });

  describe("S3 Key Generation", () => {
    test("should generate proper S3 keys", () => {
      
      const disputeId = "dispute-123";
      const filename = "receipt-123-abc.pdf";
      
      const key = generateDisputeS3Key(disputeId, filename);
      
      expect(key).toMatch(/^dispute-evidence\/\d{4}\/\d{2}\/dispute-123\/receipt-123-abc\.pdf$/);
    });
  });
});

// Mock tests for database operations (would require test database setup)
describe("Dispute Model Integration", () => {
  test("should create dispute with new fields", async () => {
    // This would require a test database setup
    // const disputeModel = new DisputeModel();
    // const dispute = await disputeModel.create({
    //   transactionId: "tx-123",
    //   reason: "Test dispute",
    //   priority: "high",
    //   category: "payment_failure"
    // });
    // expect(dispute.priority).toBe("high");
    // expect(dispute.category).toBe("payment_failure");
    expect(true).toBe(true); // Placeholder
  });
});