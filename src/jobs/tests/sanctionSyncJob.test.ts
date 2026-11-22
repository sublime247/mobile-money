/**
 * Unit tests for sanctions sync job — issue #2467
 */

jest.mock("../../services/sanctionService", () => ({
  sanctionService: {
    fetchSanctionUpdates: jest.fn(),
    updateSanctionList: jest.fn(),
    clearSanctionMatchCache: jest.fn(),
    searchSanctionsWithLevenshtein: jest.fn(),
  },
}));

jest.mock("../../config/database", () => ({
  pool: {
    connect: jest.fn(),
    query: jest.fn(),
  },
}));

jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn(),
    updateStatus: jest.fn(),
  })),
}));

jest.mock("../../utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runSanctionSyncJob } from "../sanctionSyncJob";
import { sanctionService } from "../../services/sanctionService";
import { pool } from "../../config/database";

const mockSanctionService = sanctionService as jest.Mocked<typeof sanctionService>;

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Fetch, upsert, and cache-clear pipeline
// ---------------------------------------------------------------------------

describe("runSanctionSyncJob — sync pipeline", () => {
  it("fetches updates, upserts to DB, and clears cache on success", async () => {
    const entities = [
      { name: "John Doe", source: "UN", category: "Individual", external_id: "UN-1" },
      { name: "Global Arms Ltd", source: "OFAC", category: "Entity", external_id: "OFAC-2" },
    ];

    mockSanctionService.fetchSanctionUpdates.mockResolvedValue(entities);
    mockSanctionService.updateSanctionList.mockResolvedValue(undefined);
    mockSanctionService.clearSanctionMatchCache.mockResolvedValue(undefined);
    mockSanctionService.searchSanctionsWithLevenshtein.mockResolvedValue([]);

    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);

    await runSanctionSyncJob();

    expect(mockSanctionService.fetchSanctionUpdates).toHaveBeenCalledTimes(1);
    expect(mockSanctionService.updateSanctionList).toHaveBeenCalledWith(entities);
    expect(mockSanctionService.clearSanctionMatchCache).toHaveBeenCalledTimes(1);
  });

  it("throws and does not reach cache-clear when fetchSanctionUpdates fails", async () => {
    mockSanctionService.fetchSanctionUpdates.mockRejectedValue(
      new Error("network error"),
    );

    await expect(runSanctionSyncJob()).rejects.toThrow("network error");
    expect(mockSanctionService.clearSanctionMatchCache).not.toHaveBeenCalled();
  });

  it("throws when updateSanctionList fails", async () => {
    mockSanctionService.fetchSanctionUpdates.mockResolvedValue([
      { name: "Bad Actor", source: "OFAC", external_id: "OFAC-1" },
    ]);
    mockSanctionService.updateSanctionList.mockRejectedValue(
      new Error("DB write failed"),
    );

    await expect(runSanctionSyncJob()).rejects.toThrow("DB write failed");
  });
});

// ---------------------------------------------------------------------------
// Active customer re-screening
// ---------------------------------------------------------------------------

describe("runSanctionSyncJob — active customer re-screening", () => {
  function setupSuccessfulSync(
    activeUsers: Array<{ id: string }>,
    userProfiles: Record<string, any>,
    sanctionMatches: Record<string, Array<{ entity: any; score: number }>>,
  ) {
    mockSanctionService.fetchSanctionUpdates.mockResolvedValue([]);
    mockSanctionService.updateSanctionList.mockResolvedValue(undefined);
    mockSanctionService.clearSanctionMatchCache.mockResolvedValue(undefined);

    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: activeUsers }),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);

    const { UserModel } = require("../../models/users");
    const mockFindById = jest.fn((id: string) =>
      Promise.resolve(userProfiles[id] ?? null),
    );
    const mockUpdateStatus = jest.fn().mockResolvedValue(undefined);
    UserModel.mockImplementation(() => ({
      findById: mockFindById,
      updateStatus: mockUpdateStatus,
    }));

    mockSanctionService.searchSanctionsWithLevenshtein.mockImplementation(
      (name: string) => Promise.resolve(sanctionMatches[name] ?? []),
    );

    return { mockUpdateStatus };
  }

  it("suspends a user whose name matches a sanction entry", async () => {
    const { mockUpdateStatus } = setupSuccessfulSync(
      [{ id: "user-1" }],
      {
        "user-1": {
          id: "user-1",
          displayName: "John Doe",
          firstName: "John",
          lastName: "Doe",
        },
      },
      {
        "John Doe": [
          {
            entity: { name: "John Doe", source: "UN" },
            score: 0.98,
          },
        ],
      },
    );

    await runSanctionSyncJob();

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "user-1",
      "suspended",
      "SYSTEM",
      expect.stringContaining("John Doe"),
    );
  });

  it("does not suspend a user with no sanction matches", async () => {
    const { mockUpdateStatus } = setupSuccessfulSync(
      [{ id: "user-2" }],
      { "user-2": { id: "user-2", displayName: "Jane Smith" } },
      {}, // no matches
    );

    await runSanctionSyncJob();

    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("skips users with no displayName or firstName/lastName", async () => {
    const { mockUpdateStatus } = setupSuccessfulSync(
      [{ id: "user-3" }],
      { "user-3": { id: "user-3" } }, // no name fields
      {},
    );

    await runSanctionSyncJob();

    expect(mockSanctionService.searchSanctionsWithLevenshtein).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("completes successfully with zero active users", async () => {
    setupSuccessfulSync([], {}, {});
    await expect(runSanctionSyncJob()).resolves.not.toThrow();
  });

  it("throws when active user query fails", async () => {
    mockSanctionService.fetchSanctionUpdates.mockResolvedValue([]);
    mockSanctionService.updateSanctionList.mockResolvedValue(undefined);
    mockSanctionService.clearSanctionMatchCache.mockResolvedValue(undefined);

    const mockClient = {
      query: jest.fn().mockRejectedValue(new Error("DB query failed")),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);

    await expect(runSanctionSyncJob()).rejects.toThrow("DB query failed");
  });

  it("screens displayName before first+last name combination", async () => {
    setupSuccessfulSync(
      [{ id: "user-4" }],
      {
        "user-4": {
          id: "user-4",
          displayName: "Display Name",
          firstName: "First",
          lastName: "Last",
        },
      },
      {},
    );

    await runSanctionSyncJob();

    // displayName should be screened first
    const calls = mockSanctionService.searchSanctionsWithLevenshtein.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(calls[0]).toBe("Display Name");
  });
});
