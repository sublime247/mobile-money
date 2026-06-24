import axios from "axios";
import { MTNProvider } from "../mtn";

jest.mock("axios");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const axiosMock = axios as any;

describe("MTNProvider.sendBatchPayout", () => {


  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env };
    process.env.MTN_API_KEY = "k";
    process.env.MTN_API_SECRET = "s";
    process.env.MTN_SUBSCRIPTION_KEY = "sub";
    process.env.MTN_TARGET_ENVIRONMENT = "sandbox";

    process.env.MTN_BATCH_PAYOUT_MAX_ATTEMPTS = "3";
    process.env.MTN_BATCH_PAYOUT_POLL_DELAY_MS = "1";

    // Token request
    axiosMock.post.mockImplementation(async (url: any) => {
      if (String(url).includes("/collection/token/")) {
        return { data: { access_token: "token" } } as any;
      }
      throw new Error(`Unexpected axios.post url: ${String(url)}`);
    });
  });

  afterAll(() => {
    process.env = env;
  });

  it("maps immediate per-item results without polling", async () => {
    const provider = new MTNProvider();

    const batchItems = [
      { referenceId: "tx1", phoneNumber: "+237670000001", amount: "100" },
      { referenceId: "tx2", phoneNumber: "+237670000002", amount: "200" },
    ];

    axiosMock.post.mockImplementation(async (url: any, body?: any) => {
      if (String(url).includes("/collection/token/")) {
        return { data: { access_token: "token" } } as any;
      }
      if (String(url).includes("/disbursement/v2_0/batch-payout")) {
        return {
          data: {
            batchReference: "BATCH-1",
            items: [
              {
                referenceId: "tx1",
                status: "SUCCESSFUL",
                transactionId: "pmt-1",
              },
              {
                referenceId: "tx2",
                status: "FAILED",
                errorReason: "insufficient_funds",
                transactionId: "pmt-2",
              },
            ],
          },
          status: 202,
        } as any;
      }
      throw new Error(`Unexpected axios.post url: ${String(url)}`);
    });

    axiosMock.get.mockResolvedValue({ data: {} } as any);

    const res = await provider.sendBatchPayout(batchItems);

    expect(res.success).toBe(true);
    expect(res.results).toEqual([
      { referenceId: "tx1", success: true, providerReference: "pmt-1" },
      {
        referenceId: "tx2",
        success: false,
        error: "insufficient_funds",
        providerReference: "pmt-2",
      },
    ]);

    // No polling requests expected
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it("polls until all items reach terminal states", async () => {
    const provider = new MTNProvider();

    const batchItems = [
      { referenceId: "tx1", phoneNumber: "+237670000001", amount: "100" },
      { referenceId: "tx2", phoneNumber: "+237670000002", amount: "200" },
    ];

    axiosMock.post.mockImplementation(async (url: any) => {
      if (String(url).includes("/collection/token/")) {
        return { data: { access_token: "token" } } as any;
      }
      if (String(url).includes("/disbursement/v2_0/batch-payout")) {
        return {
          data: {
            batchReference: "BATCH-2",
            items: [
              { referenceId: "tx1", status: "PENDING" },
              { referenceId: "tx2", status: "PENDING" },
            ],
          },
          status: 202,
        } as any;
      }
      throw new Error(`Unexpected axios.post url: ${String(url)}`);
    });

    // First poll: still pending
    // Second poll: terminal
    axiosMock.get
      .mockResolvedValueOnce({
        data: {
          items: [
            { referenceId: "tx1", status: "IN_PROGRESS" },
            { referenceId: "tx2", status: "PENDING" },
          ],
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              referenceId: "tx1",
              status: "SUCCESSFUL",
              financialTransactionId: "ft-1",
            },
            {
              referenceId: "tx2",
              status: "FAILED",
              errorReason: "blocked",
              financialTransactionId: "ft-2",
            },
          ],
        },
      } as any);

    const res = await provider.sendBatchPayout(batchItems);

    expect(res.success).toBe(true);
    expect(res.results[0]).toMatchObject({
      referenceId: "tx1",
      success: true,
      providerReference: "ft-1",
    });
    expect(res.results[1]).toMatchObject({
      referenceId: "tx2",
      success: false,
      error: "blocked",
      providerReference: "ft-2",
    });

    expect(axiosMock.get).toHaveBeenCalled();
  });

  it("falls back to phone+amount matching when referenceId is missing in MTN response", async () => {
    const provider = new MTNProvider();

    const batchItems = [
      { referenceId: "tx1", phoneNumber: "+237670000001", amount: "100" },
      { referenceId: "tx2", phoneNumber: "+237670000002", amount: "200" },
    ];

    axiosMock.post.mockImplementation(async (url: any) => {
      if (String(url).includes("/collection/token/")) {
        return { data: { access_token: "token" } } as any;
      }
      if (String(url).includes("/disbursement/v2_0/batch-payout")) {
        return {
          data: {
            batchReference: "BATCH-3",
            items: [
              {
                status: "SUCCESSFUL",
                phoneNumber: "+237670000001",
                amount: "100",
                transactionId: "pmt-1",
              },
              {
                status: "FAILED",
                phoneNumber: "+237670000002",
                amount: "200",
                errorReason: "daily_limit",
                transactionId: "pmt-2",
              },
            ],
          },
          status: 202,
        } as any;
      }
      throw new Error(`Unexpected axios.post url: ${String(url)}`);
    });

    axiosMock.get.mockResolvedValue({ data: {} } as any);

    const res = await provider.sendBatchPayout(batchItems);

    expect(res.results).toEqual([
      { referenceId: "tx1", success: true, providerReference: "pmt-1" },
      {
        referenceId: "tx2",
        success: false,
        error: "daily_limit",
        providerReference: "pmt-2",
      },
    ]);
  });
});

