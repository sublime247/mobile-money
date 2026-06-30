import { SnapshotService } from "../../services/snapshotService";
import { queryRead } from "../../config/database";
import { SnapshotModel } from "../../models/snapshot";
import { EmailService } from "../../services/email";

jest.mock("../../config/database");
jest.mock("../../models/snapshot");
jest.mock("../../services/email");

describe("SnapshotService", () => {
  let service: SnapshotService;
  let mockQueryRead: jest.Mock;
  let mockSnapshotModel: jest.Mocked<SnapshotModel>;
  let mockEmailService: jest.Mocked<EmailService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRead = queryRead as jest.Mock;
    mockSnapshotModel = SnapshotModel.prototype as any;
    mockEmailService = EmailService.prototype as any;
    service = new SnapshotService();
  });

  it("calculates and saves a snapshot correctly", async () => {
    // Mock Main Balance
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ balance: "1000.00" }],
    });
    // Mock Vault Balance
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ balance: "500.00" }],
    });
    // Mock Volume
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ volume: "200.00", count: 5 }],
    });

    const mockSnapshot = {
      snapshotDate: "2026-04-24",
      totalMainBalance: "1000.00",
      totalVaultBalance: "500.00",
      totalBalance: "1500.00",
      dailyVolume: "200.00",
      transactionCount: 5,
    };

    mockSnapshotModel.create.mockResolvedValue(mockSnapshot);
    mockSnapshotModel.getByDate.mockResolvedValue(null); // No previous snapshot

    const result = await service.performDailySnapshot();

    expect(result).toEqual(mockSnapshot);
    expect(mockSnapshotModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        totalBalance: "1500",
        dailyVolume: "200.00",
      }),
    );
    expect(mockEmailService.sendManagementSummary).toHaveBeenCalled();
  });

  it("calculates growth correctly when previous snapshot exists", async () => {
    // Mock today's data
    mockQueryRead.mockResolvedValueOnce({ rows: [{ balance: "1200.00" }] });
    mockQueryRead.mockResolvedValueOnce({ rows: [{ balance: "600.00" }] });
    mockQueryRead.mockResolvedValueOnce({
      rows: [{ volume: "300.00", count: 10 }],
    });

    const mockSnapshot = {
      snapshotDate: "2026-04-24",
      totalMainBalance: "1200.00",
      totalVaultBalance: "600.00",
      totalBalance: "1800.00",
      dailyVolume: "300.00",
      transactionCount: 10,
    };

    const mockYesterdaySnapshot = {
      snapshotDate: "2026-04-23",
      totalMainBalance: "1000.00",
      totalVaultBalance: "500.00",
      totalBalance: "1500.00",
      dailyVolume: "200.00",
      transactionCount: 8,
    };

    mockSnapshotModel.create.mockResolvedValue(mockSnapshot);
    mockSnapshotModel.getByDate.mockResolvedValue(mockYesterdaySnapshot);

    await service.performDailySnapshot();

    expect(mockEmailService.sendManagementSummary).toHaveBeenCalledWith(
      expect.any(String),
      mockSnapshot,
      {
        volumeGrowth: 50, // (300 - 200) / 200 * 100
        balanceGrowth: 20, // (1800 - 1500) / 1500 * 100
      },
    );
  });
});
