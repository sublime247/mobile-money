/**
 * src/database/__tests__/readOnlyTransaction.test.ts (#2483)
 *
 * Proves that reporting/export reads are wrapped in SET TRANSACTION READ ONLY,
 * that write statements are rejected before reaching Postgres, and that the
 * dedicated client is always released.
 */

const mockGetReadClient = jest.fn();

jest.mock("../../config/database", () => ({
  getReadClient: (...args: unknown[]) => mockGetReadClient(...args),
}));

jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import { ERROR_CODES } from "../../constants/errorCodes";
import { withReadOnlyTransaction } from "../readOnlyClient";

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

function makeClient(): FakeClient {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("withReadOnlyTransaction (#2483)", () => {
  it("issues BEGIN READ ONLY, COMMIT and releases the client", async () => {
    const client = makeClient();
    const seen: string[] = [];

    const value = await withReadOnlyTransaction(
      async (readClient) => {
        const result = await readClient.query("SELECT 1");
        seen.push("callback");
        return result.rows;
      },
      { clientFactory: async () => client as never },
    );

    expect(value).toEqual([]);
    expect(seen).toEqual(["callback"]);
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN READ ONLY",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each(["INSERT", "UPDATE", "DELETE", "CREATE"])(
    "rejects a %s statement before executing it",
    async (command) => {
      const client = makeClient();

      await expect(
        withReadOnlyTransaction(
          (readClient) =>
            readClient.query(`${command} INTO something VALUES (1)`),
          { clientFactory: async () => client as never },
        ),
      ).rejects.toMatchObject({
        name: "BusinessLogicError",
        code: ERROR_CODES.DATABASE_ERROR,
        message: expect.stringContaining(command),
      });

      const statements = client.query.mock.calls.map((call) => call[0]);
      expect(statements).toContain("BEGIN READ ONLY");
      expect(statements).toContain("ROLLBACK");
      // The rejected statement never reached Postgres.
      expect(statements).not.toContainEqual(
        expect.stringContaining(`${command} INTO`),
      );
      expect(client.release).toHaveBeenCalledTimes(1);
    },
  );

  it("rolls back and releases when the callback throws", async () => {
    const client = makeClient();
    const failure = new Error("report query failed");

    await expect(
      withReadOnlyTransaction(
        async () => {
          throw failure;
        },
        { clientFactory: async () => client as never },
      ),
    ).rejects.toBe(failure);

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the client even when acquiring a transaction fails", async () => {
    const client = makeClient();
    client.query.mockRejectedValueOnce(new Error("BEGIN failed"));

    await expect(
      withReadOnlyTransaction(async () => undefined, {
        clientFactory: async () => client as never,
      }),
    ).rejects.toThrow("BEGIN failed");

    expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("uses the exported replica-first client when no factory is injected", async () => {
    const client = makeClient();
    mockGetReadClient.mockResolvedValueOnce(client);

    await withReadOnlyTransaction(async (readClient) => {
      await readClient.query("SELECT 1");
    });

    expect(mockGetReadClient).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith("BEGIN READ ONLY");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
