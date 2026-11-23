const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

import crypto from "crypto";
import {
  ProviderCredentialRepository,
  ProviderCredentialRow,
} from "../providerCredential";

const SECRET = "mtn-live-api-key-1234567890";

describe("ProviderCredentialRepository", () => {
  const repo = new ProviderCredentialRepository();
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.PROVIDER_SECRETS_MASTER_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    delete process.env.PROVIDER_SECRETS_MASTER_KEY_VERSION;
    delete process.env.PROVIDER_SECRETS_PREVIOUS_KEYS;
    mockQueryRead.mockReset();
    mockQueryWrite.mockReset();
  });

  afterAll(() => {
    process.env = saved;
  });

  /** Captures what upsert() writes and returns it as a stored row. */
  async function storeAndCapture(
    provider: string,
    name: string,
    value: string,
  ): Promise<ProviderCredentialRow> {
    mockQueryWrite.mockResolvedValueOnce({
      rows: [
        {
          id: "cred-1",
          provider: provider.toLowerCase(),
          credential_name: name,
          key_version: "v1",
          created_by: "admin-1",
          updated_by: "admin-1",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });
    await repo.upsert(provider, name, value, "admin-1");

    const params = mockQueryWrite.mock.calls.at(-1)![1] as unknown[];
    return {
      id: "cred-1",
      provider: params[0] as string,
      credential_name: params[1] as string,
      encrypted_value: params[2] as Buffer,
      iv: params[3] as Buffer,
      auth_tag: params[4] as Buffer,
      encrypted_dek: params[5] as Buffer,
      dek_iv: params[6] as Buffer,
      dek_auth_tag: params[7] as Buffer,
      key_version: params[8] as string,
      created_by: "admin-1",
      updated_by: "admin-1",
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  it("encrypts before save: no plaintext reaches the database", async () => {
    const row = await storeAndCapture("MTN", "api_key", SECRET);

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toContain("INSERT INTO provider_credentials");
    expect(params[0]).toBe("mtn");
    for (const param of params as unknown[]) {
      expect(String(param)).not.toContain(SECRET);
      if (Buffer.isBuffer(param)) {
        expect(param.includes(Buffer.from(SECRET))).toBe(false);
      }
    }
    expect(row.iv).toHaveLength(12);
    expect(row.auth_tag).toHaveLength(16);
  });

  it("returns metadata only from upsert", async () => {
    mockQueryWrite.mockResolvedValueOnce({
      rows: [
        {
          id: "cred-1",
          provider: "mtn",
          credential_name: "api_key",
          key_version: "v1",
          created_by: null,
          updated_by: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const summary = await repo.upsert("mtn", "api_key", SECRET);

    expect(summary).not.toHaveProperty("value");
    expect(mockQueryWrite.mock.calls[0][0]).not.toMatch(
      /RETURNING \*|RETURNING[\s\S]*encrypted_value/,
    );
  });

  it("decrypts transparently on read", async () => {
    const row = await storeAndCapture("mtn", "api_key", SECRET);
    mockQueryRead.mockResolvedValueOnce({ rows: [row] });

    const credential = await repo.get("MTN", "api_key");

    expect(mockQueryRead).toHaveBeenCalledWith(expect.any(String), [
      "mtn",
      "api_key",
    ]);
    expect(credential?.value).toBe(SECRET);
    expect(credential?.provider).toBe("mtn");
  });

  it("returns null when the credential does not exist", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });
    await expect(repo.get("mtn", "missing")).resolves.toBeNull();
  });

  it("fails to read when the master key has changed", async () => {
    const row = await storeAndCapture("mtn", "api_key", SECRET);
    process.env.PROVIDER_SECRETS_MASTER_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    mockQueryRead.mockResolvedValueOnce({ rows: [row] });

    await expect(repo.get("mtn", "api_key")).rejects.toThrow(
      "Provider secret decryption failed",
    );
  });

  it("fails to read a tampered auth tag", async () => {
    const row = await storeAndCapture("mtn", "api_key", SECRET);
    row.auth_tag = Buffer.from(row.auth_tag);
    row.auth_tag[15] ^= 0xff;
    mockQueryRead.mockResolvedValueOnce({ rows: [row] });

    await expect(repo.get("mtn", "api_key")).rejects.toThrow(
      "Provider secret decryption failed",
    );
  });

  it("refuses a value copied from another provider's row", async () => {
    const airtelRow = await storeAndCapture("airtel", "api_key", SECRET);
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ ...airtelRow, provider: "mtn" }],
    });

    await expect(repo.get("mtn", "api_key")).rejects.toThrow(
      "Provider secret decryption failed",
    );
  });

  it("lists credentials without selecting encrypted columns", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });

    await repo.listForProvider("MTN");

    const [sql, params] = mockQueryRead.mock.calls[0];
    expect(sql).not.toContain("encrypted_value");
    expect(sql).not.toContain("SELECT *");
    expect(params).toEqual(["mtn"]);
  });

  it("rejects empty values", async () => {
    await expect(repo.upsert("mtn", "api_key", "")).rejects.toThrow(
      "Credential value must not be empty",
    );
    expect(mockQueryWrite).not.toHaveBeenCalled();
  });
});
