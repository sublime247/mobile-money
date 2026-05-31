import { StellarService } from "../stellarService";
import { sanctionService, SanctionScreeningError } from "../../sanctionService";

jest.mock("../../sanctionService", () => ({
  sanctionService: { checkParties: jest.fn() },
  SanctionScreeningError: class SanctionScreeningError extends Error {
    constructor(
      public party: string,
      public screenedName: string,
      public matchedEntity: string,
      public score: number,
      public source: string,
    ) {
      super(
        `Sanction screening blocked: ${party} "${screenedName}" matched "${matchedEntity}"`,
      );
      this.name = "SanctionScreeningError";
    }
  },
}));

jest.mock("../../../config/stellar", () => ({
  getStellarServer: () => ({}),
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));

describe("StellarService.sendPayment — sanction gate", () => {
  let service: StellarService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Force mock mode so no real Stellar calls are made
    delete process.env.STELLAR_ISSUER_SECRET;
    service = new StellarService();
  });

  it("calls checkParties with sender and receiver names before submitting", async () => {
    (sanctionService.checkParties as jest.Mock).mockResolvedValue(undefined);
    await service.sendPayment("GDEST...", "100", "Alice Clean", "Bob Safe");
    expect(sanctionService.checkParties).toHaveBeenCalledWith(
      "Alice Clean",
      "Bob Safe",
    );
  });

  it("throws SanctionScreeningError and does NOT submit when sender is sanctioned", async () => {
    const err = new (SanctionScreeningError as any)(
      "sender",
      "Osama bin Laden",
      "Osama bin Laden",
      1.0,
      "UN",
    );
    (sanctionService.checkParties as jest.Mock).mockRejectedValue(err);

    await expect(
      service.sendPayment("GDEST...", "100", "Osama bin Laden", "Bob Safe"),
    ).rejects.toThrow("Sanction screening blocked");
  });

  it("throws SanctionScreeningError and does NOT submit when receiver is sanctioned", async () => {
    const err = new (SanctionScreeningError as any)(
      "receiver",
      "Global Arms Ltd",
      "Global Arms Ltd",
      0.95,
      "OFAC",
    );
    (sanctionService.checkParties as jest.Mock).mockRejectedValue(err);

    await expect(
      service.sendPayment("GDEST...", "100", "Alice Clean", "Global Arms Ltd"),
    ).rejects.toThrow("Sanction screening blocked");
  });

  it("skips sanction check when names are not provided", async () => {
    await service.sendPayment("GDEST...", "100");
    expect(sanctionService.checkParties).not.toHaveBeenCalled();
  });
});
