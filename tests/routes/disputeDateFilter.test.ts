import { DisputeService } from "../../src/services/dispute";
import { DisputeModel } from "../../src/models/dispute";

describe("Dispute Date Range Filtering", () => {
  let disputeService: DisputeService;

  beforeEach(() => {
    disputeService = new DisputeService();
    jest.clearAllMocks();
  });

  it("passes parsed Date objects properly to dispute model report generation", async () => {
    const mockReport = [
      { status: "open" as const, count: "5", avgResolutionHours: null },
      { status: "resolved" as const, count: "10", avgResolutionHours: "2.5" },
    ];

    const generateReportSpy = jest
      .spyOn(DisputeModel.prototype, "generateReport")
      .mockResolvedValue(mockReport);

    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-31T23:59:59.999Z");

    const result = await disputeService.generateReport({
      from,
      to,
      assignedTo: "agent-1",
    });

    expect(generateReportSpy).toHaveBeenCalledWith({
      from,
      to,
      assignedTo: "agent-1",
    });

    expect(result.totals.total).toBe(15);
    expect(result.totals.open).toBe(5);
    expect(result.totals.resolved).toBe(10);
  });
});
