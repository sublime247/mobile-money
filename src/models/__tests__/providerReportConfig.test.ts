const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

import {
  ProviderReportConfigModel,
  ProviderReportConfigRow,
} from "../providerReportConfig";
import {
  encryptSecret,
  decryptSecret,
  isEncryptedValue,
} from "../../utils/crypto";

describe("ProviderReportConfigModel credential encryption (#2031)", () => {
  const model = new ProviderReportConfigModel();
  const apiKey = "mtn-report-api-key";
  const apiSecret = "mtn-report-api-secret";

  const row = (
    overrides: Partial<ProviderReportConfigRow> = {},
  ): ProviderReportConfigRow => ({
    id: "cfg-1",
    provider: "mtn",
    is_enabled: true,
    download_method: "api",
    api_endpoint: "https://provider.test/report/{date}",
    api_key: encryptSecret(apiKey) as string,
    api_secret: encryptSecret(apiSecret) as string,
    report_timezone: "UTC",
    report_time_format: "YYYY-MM-DD",
    ...overrides,
  });

  beforeEach(() => {
    mockQueryRead.mockReset();
    mockQueryWrite.mockReset();
  });

  it("encrypts credentials before writing them", async () => {
    mockQueryWrite.mockResolvedValueOnce({ rows: [row()] });

    const saved = await model.updateCredentials({
      provider: "mtn",
      isEnabled: true,
      downloadMethod: "api",
      apiEndpoint: "https://provider.test/report/{date}",
      apiKey,
      apiSecret,
    });

    const params = mockQueryWrite.mock.calls[0][1] as unknown[];
    const storedKey = params[4] as string;
    const storedSecret = params[5] as string;

    expect(storedKey).not.toBe(apiKey);
    expect(storedSecret).not.toBe(apiSecret);
    expect(isEncryptedValue(storedKey)).toBe(true);
    expect(isEncryptedValue(storedSecret)).toBe(true);
    expect(decryptSecret(storedKey)).toBe(apiKey);
    expect(decryptSecret(storedSecret)).toBe(apiSecret);

    // Returned configuration is transparently decrypted
    expect(saved.api_key).toBe(apiKey);
    expect(saved.api_secret).toBe(apiSecret);
  });

  it("decrypts credentials when loading enabled configs", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [row()] });

    const configs = await model.findEnabled();

    expect(configs).toHaveLength(1);
    expect(configs[0].api_key).toBe(apiKey);
    expect(configs[0].api_secret).toBe(apiSecret);
    expect(configs[0].api_endpoint).toBe("https://provider.test/report/{date}");
  });

  it("scopes findEnabled to a provider when given one", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [row({ provider: "airtel" })],
    });

    const config = await model.findEnabledByProvider("airtel");

    expect(mockQueryRead.mock.calls[0][1]).toEqual(["airtel"]);
    expect(config?.provider).toBe("airtel");
    expect(config?.api_key).toBe(apiKey);
  });

  it("returns null when no enabled config exists for a provider", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [] });
    await expect(model.findEnabledByProvider("orange")).resolves.toBeNull();
  });

  it("keeps legacy plaintext credentials readable", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [row({ api_key: apiKey, api_secret: apiSecret })],
    });

    const configs = await model.findEnabled();
    expect(configs[0].api_key).toBe(apiKey);
    expect(configs[0].api_secret).toBe(apiSecret);
  });
});
