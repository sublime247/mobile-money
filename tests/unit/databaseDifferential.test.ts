import { v4 as uuidv4 } from "uuid";
import {
  MockDatabaseStore,
  RealDatabaseState,
  DbDifferentialTester,
} from "../../src/utils/dbDifferentialTester";

jest.mock("../../src/config/database", () => {
  const original = jest.requireActual("../../src/config/database");
  const { createInMemoryDbMock } = require("../../src/utils/mockDb");
  const { mockQuery } = createInMemoryDbMock();
  return {
    ...original,
    pool: { query: mockQuery },
    queryRead: mockQuery,
    queryWrite: mockQuery,
  };
});

describe("[Unit Test] Database State Differential Suite", () => {
  let mockStore: MockDatabaseStore;
  let realState: RealDatabaseState;

  beforeEach(() => {
    mockStore = new MockDatabaseStore();
    realState = new RealDatabaseState();
  });

  it("verifies user and vault differential parity in unit test suite", async () => {
    const ownerId = uuidv4();
    const vaultId = uuidv4();

    const userPayload = {
      id: ownerId,
      phone_number: "+2347000000001",
      kyc_level: "full" as const,
    };

    const vaultPayload = {
      id: vaultId,
      name: "Unit Differential Vault",
      owner_id: ownerId,
      balance: 100.0,
      status: "active" as const,
    };

    // User Creation Differential
    const userDiff = await DbDifferentialTester.compare(
      "Unit User Creation",
      async () => mockStore.createUser(userPayload),
      async () => realState.createUser(userPayload),
    );
    expect(userDiff.isEqual).toBe(true);

    // Vault Creation Differential
    const vaultDiff = await DbDifferentialTester.compare(
      "Unit Vault Creation",
      async () => mockStore.createVault(vaultPayload),
      async () => realState.createVault(vaultPayload),
    );
    expect(vaultDiff.isEqual).toBe(true);
  });

  it("verifies transaction state transition differential parity", async () => {
    const userId = uuidv4();
    const txId = uuidv4();

    await mockStore.createUser({ id: userId, phone_number: "+254711223344", kyc_level: "basic" });
    await realState.createUser({ id: userId, phone_number: "+254711223344", kyc_level: "basic" });

    const txPayload = {
      id: txId,
      user_id: userId,
      reference_number: "UNIT-TX-DIFF-001",
      type: "deposit" as const,
      amount: 50.0,
      phone_number: "+254711223344",
      provider: "MPESA",
      stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      status: "pending" as const,
    };

    const txCreateDiff = await DbDifferentialTester.compare(
      "Unit Tx Creation",
      async () => mockStore.createTransaction(txPayload),
      async () => realState.createTransaction(txPayload),
    );
    expect(txCreateDiff.isEqual).toBe(true);

    const txUpdateDiff = await DbDifferentialTester.compare(
      "Unit Tx Completion",
      async () => mockStore.updateTransactionStatus(txId, "completed"),
      async () => realState.updateTransactionStatus(txId, "completed"),
    );
    expect(txUpdateDiff.isEqual).toBe(true);
  });
});
