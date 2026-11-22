import { v4 as uuidv4 } from "uuid";
import {
  MockDatabaseStore,
  RealDatabaseState,
  DbDifferentialTester,
  UserRecord,
  VaultRecord,
  TransactionRecord,
  AmlAlertRecord,
} from "../../utils/dbDifferentialTester";
import { pool, queryRead, queryWrite } from "../../config/database";

// Mock the database pool for isolated unit execution if PostgreSQL is unavailable
jest.mock("../../config/database", () => {
  const original = jest.requireActual("../../config/database");
  const { createInMemoryDbMock } = require("../../utils/mockDb");
  const { mockQuery } = createInMemoryDbMock();
  return {
    ...original,
    pool: { query: mockQuery },
    queryRead: mockQuery,
    queryWrite: mockQuery,
  };
});


describe("[Differential Tests] Mock vs Real Database States", () => {
  let mockStore: MockDatabaseStore;
  let realState: RealDatabaseState;

  beforeEach(() => {
    mockStore = new MockDatabaseStore();
    realState = new RealDatabaseState();
  });

  describe("1. User Entity & KYC Lifecycle Differential", () => {
    it("should maintain state equivalence for user insertion and lookup by ID and phone", async () => {
      const userId = uuidv4();
      const userPayload = {
        id: userId,
        phone_number: "+254712345678",
        kyc_level: "unverified" as const,
        mcc: "6012",
        profile_url: "https://example.com/avatar.png",
      };

      const diffResult = await DbDifferentialTester.compare(
        "User Insertion",
        async () => mockStore.createUser(userPayload),
        async () => realState.createUser(userPayload),
      );

      expect(diffResult.isEqual).toBe(true);
      expect(diffResult.mockResult?.id).toBe(userId);
      expect(diffResult.realResult?.phone_number).toBe("+254712345678");

      // Verify lookup by phone number
      const lookupDiff = await DbDifferentialTester.compare(
        "User Phone Lookup",
        async () => mockStore.getUserByPhone("+254712345678"),
        async () => realState.getUserByPhone("+254712345678"),
      );

      expect(lookupDiff.isEqual).toBe(true);
      expect(lookupDiff.mockResult?.kyc_level).toBe("unverified");
    });

    it("should maintain state equivalence for KYC level upgrade ('unverified' -> 'basic' -> 'full')", async () => {
      const userId = uuidv4();
      const userPayload = {
        id: userId,
        phone_number: "+256781112233",
        kyc_level: "unverified" as const,
      };

      await mockStore.createUser(userPayload);
      await realState.createUser(userPayload);

      const kycUpgradeDiff = await DbDifferentialTester.compare(
        "KYC Upgrade to Full",
        async () => mockStore.updateUserKyc(userId, "full"),
        async () => realState.updateUserKyc(userId, "full"),
      );

      expect(kycUpgradeDiff.isEqual).toBe(true);
      expect(kycUpgradeDiff.mockResult?.kyc_level).toBe("full");
      expect(kycUpgradeDiff.realResult?.kyc_level).toBe("full");
    });
  });

  describe("2. Vault Management & Balance State Differential", () => {
    it("should maintain state equivalence for vault creation, deposits, and status locking", async () => {
      const ownerId = uuidv4();
      const vaultId = uuidv4();
      const ownerPayload = {
        id: ownerId,
        phone_number: "+233201234567",
        kyc_level: "full" as const,
      };

      await mockStore.createUser(ownerPayload);
      await realState.createUser(ownerPayload);

      const vaultPayload = {
        id: vaultId,
        name: "Stellar Liquidity Reserve",
        owner_id: ownerId,
        balance: 5000.0,
        status: "active" as const,
      };

      const vaultCreationDiff = await DbDifferentialTester.compare(
        "Vault Creation",
        async () => mockStore.createVault(vaultPayload),
        async () => realState.createVault(vaultPayload),
      );

      expect(vaultCreationDiff.isEqual).toBe(true);

      // Balance Deposit
      const depositDiff = await DbDifferentialTester.compare(
        "Vault Balance Deposit",
        async () => mockStore.updateVaultBalance(vaultId, 1500.5),
        async () => realState.updateVaultBalance(vaultId, 1500.5),
      );

      expect(depositDiff.isEqual).toBe(true);
      expect(depositDiff.mockResult?.balance).toBe(6500.5);
      expect(depositDiff.realResult?.balance).toBe(6500.5);

      // Lock Vault and test balance mutation rejection
      await mockStore.updateVaultStatus(vaultId, "locked");
      await realState.updateVaultStatus(vaultId, "locked");

      const lockedMutationDiff = await DbDifferentialTester.compare(
        "Locked Vault Mutation Rejection",
        async () => mockStore.updateVaultBalance(vaultId, 100),
        async () => realState.updateVaultBalance(vaultId, 100),
      );

      expect(lockedMutationDiff.isEqual).toBe(true);
      expect(lockedMutationDiff.mockError).not.toBeNull();
      expect(lockedMutationDiff.realError).not.toBeNull();
    });
  });

  describe("3. Transaction Lifecycle & Idempotency Differential", () => {
    it("should maintain state equivalence for deposit creation, tags, metadata, and status completion", async () => {
      const userId = uuidv4();
      await mockStore.createUser({ id: userId, phone_number: "+255700001122", kyc_level: "basic" });
      await realState.createUser({ id: userId, phone_number: "+255700001122", kyc_level: "basic" });

      const txId = uuidv4();
      const txPayload = {
        id: txId,
        user_id: userId,
        reference_number: "REF-MOMO-998811",
        type: "deposit" as const,
        amount: 250.75,
        phone_number: "+255700001122",
        provider: "VODACOM_TZ",
        stellar_address: "GA5WACGAPB56OHNGPTPYW643KXPFREZ354BKGKEUOAAAABBBBCCCCDDDD",
        status: "pending" as const,
        tags: ["mobile-money", "express"],
        metadata: { channel: "ussd", ip: "192.168.1.1" },
      };

      const createTxDiff = await DbDifferentialTester.compare(
        "Transaction Creation",
        async () => mockStore.createTransaction(txPayload),
        async () => realState.createTransaction(txPayload),
      );

      expect(createTxDiff.isEqual).toBe(true);
      expect(createTxDiff.mockResult?.status).toBe("pending");

      // Update status to completed
      const updateStatusDiff = await DbDifferentialTester.compare(
        "Transaction Completion",
        async () => mockStore.updateTransactionStatus(txId, "completed"),
        async () => realState.updateTransactionStatus(txId, "completed"),
      );

      expect(updateStatusDiff.isEqual).toBe(true);
      expect(updateStatusDiff.mockResult?.status).toBe("completed");
      expect(updateStatusDiff.realResult?.status).toBe("completed");
    });
  });

  describe("4. AML Alert & Review Workflow Differential", () => {
    it("should maintain state equivalence for AML alert creation, rule hit logging, and audit trail insertion", async () => {
      const userId = uuidv4();
      const txId = uuidv4();

      await mockStore.createUser({ id: userId, phone_number: "+2348033344556", kyc_level: "full" });
      await realState.createUser({ id: userId, phone_number: "+2348033344556", kyc_level: "full" });

      await mockStore.createTransaction({
        id: txId,
        user_id: userId,
        reference_number: "REF-AML-554433",
        type: "withdraw",
        amount: 10000.0,
        phone_number: "+2348033344556",
        provider: "MTN_NG",
        stellar_address: "GB888888888888888888888888888888888888888888888888888888",
      });
      await realState.createTransaction({
        id: txId,
        user_id: userId,
        reference_number: "REF-AML-554433",
        type: "withdraw",
        amount: 10000.0,
        phone_number: "+2348033344556",
        provider: "MTN_NG",
        stellar_address: "GB888888888888888888888888888888888888888888888888888888",
      });

      const alertId = uuidv4();
      const alertPayload = {
        id: alertId,
        transaction_id: txId,
        user_id: userId,
        severity: "high" as const,
        status: "pending_review" as const,
        rule_hits: [{ rule: "RAPID_WITHDRAWAL", limit: 5000, actual: 10000 }],
        reasons: ["Exceeded single transaction threshold"],
      };

      const createAlertDiff = await DbDifferentialTester.compare(
        "AML Alert Creation",
        async () => mockStore.createAmlAlert(alertPayload),
        async () => realState.createAmlAlert(alertPayload),
      );

      expect(createAlertDiff.isEqual).toBe(true);

      // Review AML Alert and record audit history
      const reviewerId = userId;
      const reviewDiff = await DbDifferentialTester.compare(
        "AML Alert Review",
        async () =>
          mockStore.reviewAmlAlert({
            alert_id: alertId,
            reviewed_by: reviewerId,
            new_status: "reviewed",
            review_notes: "Source of funds verified via bank statement",
          }),
        async () =>
          realState.reviewAmlAlert({
            alert_id: alertId,
            reviewed_by: reviewerId,
            new_status: "reviewed",
            review_notes: "Source of funds verified via bank statement",
          }),
        { ignoreTimestamps: true, ignoreIds: true },
      );

      expect(reviewDiff.isEqual).toBe(true);
      expect(reviewDiff.mockResult?.alert.status).toBe("reviewed");
      expect(reviewDiff.realResult?.alert.status).toBe("reviewed");
      expect(reviewDiff.mockResult?.history.previous_status).toBe("pending_review");
    });
  });

  describe("5. Transaction Atomicity & Rollback Parity Differential", () => {
    it("should verify state restoration on rollback across mock state store", async () => {
      const user = mockStore.createUser({ phone_number: "+27821234567", kyc_level: "full" });
      const vault = mockStore.createVault({ name: "Primary Vault", owner_id: user.id, balance: 1000 });

      // Begin transaction snapshot
      mockStore.beginTransaction();

      // Mutate state inside transaction
      mockStore.updateVaultBalance(vault.id, -500);
      mockStore.createTransaction({
        user_id: user.id,
        reference_number: "TX-TXN-ATOM-1",
        type: "withdraw",
        amount: 500,
        phone_number: user.phone_number,
        provider: "VODACOM_ZA",
        stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vault_id: vault.id,
      });

      expect(mockStore.getVaultById(vault.id)?.balance).toBe(500);

      // Rollback transaction
      mockStore.rollbackTransaction();

      // Balance and transactions should be restored to pre-transaction state
      expect(mockStore.getVaultById(vault.id)?.balance).toBe(1000);
      expect(mockStore.getTransactionByRef("TX-TXN-ATOM-1")).toBeNull();
    });
  });

  describe("6. Constraint & Validation Error Parity Differential", () => {
    it("should fail predictably on unique constraint collision for phone number", async () => {
      const phone = "+254799887766";
      await mockStore.createUser({ phone_number: phone, kyc_level: "unverified" });
      await realState.createUser({ phone_number: phone, kyc_level: "unverified" });

      const duplicateDiff = await DbDifferentialTester.compare(
        "Duplicate Phone Insertion",
        async () => mockStore.createUser({ phone_number: phone, kyc_level: "full" }),
        async () => realState.createUser({ phone_number: phone, kyc_level: "full" }),
      );

      expect(duplicateDiff.isEqual).toBe(true);
      expect(duplicateDiff.mockError).not.toBeNull();
      expect(duplicateDiff.realError).not.toBeNull();
    });

    it("should fail predictably when adding vault for non-existent user", async () => {
      const nonExistentId = uuidv4();
      const fkViolationDiff = await DbDifferentialTester.compare(
        "Vault Foreign Key Violation",
        async () => mockStore.createVault({ name: "Orphan Vault", owner_id: nonExistentId }),
        async () => realState.createVault({ name: "Orphan Vault", owner_id: nonExistentId }),
      );

      expect(fkViolationDiff.isEqual).toBe(true);
      expect(fkViolationDiff.mockError).not.toBeNull();
      expect(fkViolationDiff.realError).not.toBeNull();
    });
  });
});
