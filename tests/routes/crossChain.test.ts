import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import {
  CrossChainMonitorService,
  ChainAssetSnapshot,
} from "../../src/services/crossChainMonitorService";

jest.mock("../../src/services/crossChainMonitorService");
jest.mock("../../src/config/stellar");
jest.mock("../../src/utils/metrics", () => ({
  crossChainBalanceGauge: { set: jest.fn() },
  crossChainAnomalyTotal: { inc: jest.fn() },
}));

// Mock auth middleware before importing the router to avoid envalid env validation
const mockRequireAuth = jest.fn();
jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) =>
    mockRequireAuth(req, res, next),
}));

// Import router after mocks are set up
import crossChainRouter from "../../src/routes/crossChain";

const mockGetLastSnapshot = jest.fn();
jest.mocked(CrossChainMonitorService.getInstance).mockReturnValue({
  getLastSnapshot: mockGetLastSnapshot,
  snapshot: jest.fn().mockResolvedValue([]),
} as any);

function buildApp(authenticated: boolean) {
  const app = express();
  app.use(express.json());

  // Configure mockRequireAuth behaviour for this test
  mockRequireAuth.mockImplementation(
    (req: Request, res: Response, next: NextFunction) => {
      if (authenticated) {
        (req as any).user = { id: "user-1", role: "user" };
        return next();
      }
      res.status(401).json({ error: "Unauthorized" });
    },
  );

  app.use("/api/cross-chain", crossChainRouter);
  return app;
}

describe("GET /api/cross-chain/balances", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    const app = buildApp(false);
    const res = await request(app).get("/api/cross-chain/balances");
    expect(res.status).toBe(401);
  });

  it("returns 200 with empty array when no snapshots exist", async () => {
    mockGetLastSnapshot.mockReturnValue([]);
    const app = buildApp(true);

    const res = await request(app).get("/api/cross-chain/balances");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns the last snapshot from CrossChainMonitorService", async () => {
    const snapshots: ChainAssetSnapshot[] = [
      {
        chain: "stellar",
        asset: "XLM",
        address: "GABC123",
        balance: "100.0000000",
        capturedAt: new Date("2026-04-24T12:00:00.000Z"),
      },
      {
        chain: "mtn",
        asset: "XAF",
        address: "mtn",
        balance: "0",
        capturedAt: new Date("2026-04-24T12:00:00.000Z"),
      },
    ];
    mockGetLastSnapshot.mockReturnValue(snapshots);
    const app = buildApp(true);

    const res = await request(app).get("/api/cross-chain/balances");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].chain).toBe("stellar");
    expect(res.body[0].asset).toBe("XLM");
    expect(res.body[0].address).toBe("GABC123");
    expect(res.body[0].balance).toBe("100.0000000");
    expect(res.body[1].chain).toBe("mtn");
  });

  it("calls CrossChainMonitorService.getInstance().getLastSnapshot()", async () => {
    mockGetLastSnapshot.mockReturnValue([]);
    const app = buildApp(true);

    await request(app).get("/api/cross-chain/balances");

    expect(CrossChainMonitorService.getInstance).toHaveBeenCalled();
    expect(mockGetLastSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns all four chains when all are present in snapshot", async () => {
    const snapshots: ChainAssetSnapshot[] = [
      {
        chain: "stellar",
        asset: "XLM",
        address: "GABC",
        balance: "10",
        capturedAt: new Date(),
      },
      {
        chain: "mtn",
        asset: "XAF",
        address: "mtn",
        balance: "0",
        capturedAt: new Date(),
      },
      {
        chain: "airtel",
        asset: "XAF",
        address: "airtel",
        balance: "0",
        capturedAt: new Date(),
      },
      {
        chain: "orange",
        asset: "XAF",
        address: "orange",
        balance: "0",
        capturedAt: new Date(),
      },
    ];
    mockGetLastSnapshot.mockReturnValue(snapshots);
    const app = buildApp(true);

    const res = await request(app).get("/api/cross-chain/balances");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const chains = res.body.map((s: ChainAssetSnapshot) => s.chain);
    expect(chains).toContain("stellar");
    expect(chains).toContain("mtn");
    expect(chains).toContain("airtel");
    expect(chains).toContain("orange");
  });
});
