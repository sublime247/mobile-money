import axios from "axios";
import { AirtelService } from "../../../../src/services/mobilemoney/providers/airtel";

jest.mock("axios");

describe("AirtelService", () => {
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.AIRTEL_API_KEY = "test-api-key";
    process.env.AIRTEL_API_SECRET = "test-api-secret";
    process.env.AIRTEL_BASE_URL = "https://example.test";
  });

  it("formats Airtel payout phone numbers before sending the payload", async () => {
    const client: any = {
      post: jest.fn(),
      get: jest.fn(),
    };

    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockImplementation((url: string, body?: any) => {
      if (url === "/auth/oauth2/token") {
        return Promise.resolve({
          data: { access_token: "token-123", expires_in: 3600 },
        });
      }

      if (url === "/standard/v1/disbursements/") {
        return Promise.resolve({
          status: 200,
          data: {
            status: { success: true, code: "DS_SUCCESS" },
            data: {
              transaction: {
                id: body.reference,
                status: "TS",
              },
            },
          },
        });
      }

      return Promise.reject(new Error(`unexpected request: ${url}`));
    });

    const service = new AirtelService();

    await service.sendPayout("+237670000000", "500");
    await service.sendPayout("237670000001", "500");
    await service.sendPayout("670000002", "500");

    const payoutCalls = client.post.mock.calls.filter(
      ([url]) => url === "/standard/v1/disbursements/",
    );

    expect(payoutCalls).toHaveLength(3);
    expect(payoutCalls[0][1]).toMatchObject({
      payee: { msisdn: "670000000" },
    });
    expect(payoutCalls[1][1]).toMatchObject({
      payee: { msisdn: "670000001" },
    });
    expect(payoutCalls[2][1]).toMatchObject({
      payee: { msisdn: "670000002" },
    });
  });

  describe("getDisbursementStatus", () => {
    function makeClient() {
      return {
        post: jest.fn(),
        get: jest.fn(),
      } as any;
    }

    it("queries the disbursement-specific status endpoint (not the general payments endpoint)", async () => {
      const client = makeClient();
      mockedAxios.create.mockReturnValue(client);

      client.post.mockImplementation((url: string) => {
        if (url === "/auth/oauth2/token") {
          return Promise.resolve({
            data: { access_token: "token-123", expires_in: 3600 },
          });
        }
        return Promise.reject(new Error(`unexpected POST: ${url}`));
      });

      client.get.mockImplementation((url: string) =>
        Promise.resolve({
          status: 200,
          data: {
            data: { transaction: { id: "ref-1", status: "TS" } },
          },
          config: { url },
        }),
      );

      const service = new AirtelService();
      const result = await service.getDisbursementStatus("ref-1");

      expect(result).toEqual({ status: "completed" });
      expect(client.get).toHaveBeenCalledWith(
        expect.stringContaining("/standard/v1/disbursements/ref-1"),
        expect.anything(),
      );
      expect(client.get).not.toHaveBeenCalledWith(
        expect.stringContaining("/standard/v1/payments/ref-1"),
        expect.anything(),
      );
    });

    it("maps TF to failed and TP to pending", async () => {
      const client = makeClient();
      mockedAxios.create.mockReturnValue(client);
      client.post.mockResolvedValue({
        data: { access_token: "token-123", expires_in: 3600 },
      });

      client.get.mockResolvedValueOnce({
        status: 200,
        data: { data: { transaction: { id: "ref-2", status: "TF" } } },
      });
      const service = new AirtelService();
      await expect(service.getDisbursementStatus("ref-2")).resolves.toEqual({
        status: "failed",
      });

      client.get.mockResolvedValueOnce({
        status: 200,
        data: { data: { transaction: { id: "ref-3", status: "TP" } } },
      });
      await expect(service.getDisbursementStatus("ref-3")).resolves.toEqual({
        status: "pending",
      });
    });

    it("returns unknown status when the provider request fails", async () => {
      const client = makeClient();
      mockedAxios.create.mockReturnValue(client);
      client.post.mockResolvedValue({
        data: { access_token: "token-123", expires_in: 3600 },
      });
      client.get.mockRejectedValue(new Error("network error"));

      const service = new AirtelService();
      await expect(
        service.getDisbursementStatus("ref-4"),
      ).resolves.toEqual({ status: "unknown" });
    });
  });
});
