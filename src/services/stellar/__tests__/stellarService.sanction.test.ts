import { StellarService } from "../stellarService";
import { sanctionService, SanctionScreeningError } from "../../sanctionService";

jest.mock("../../sanctionService", () => ({
  sanctionService: {
    checkParties: jest.fn(),
    checkPartiesByAddress: jest.fn(),
  },
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

jest.mock("../../../stellar/muxed", () => ({
  resolveToBaseAddress: (address: string) => {
    // If it's a muxed address (starts with M), resolve to base address
    if (address.startsWith("M")) {
      return "GDEST..."; // Return the base address
    }
    return address;
  },
  isMuxedAddress: (address: string) => address.startsWith("M"),
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

  describe("Muxed Account Support (SEP-23)", () => {
    it("should resolve muxed address to base address before sending payment", async () => {
      (sanctionService.checkParties as jest.Mock).mockResolvedValue(undefined);
      (sanctionService.checkPartiesByAddress as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.sendPayment(
        "MDEST...MUXED",
        "100",
        "Alice Clean",
        "Bob Safe",
      );

      // Should attempt to resolve the muxed address
      expect(sanctionService.checkPartiesByAddress).toHaveBeenCalled();
    });

    it("should throw error for invalid muxed address", async () => {
      (sanctionService.checkParties as jest.Mock).mockResolvedValue(undefined);
      // Mock resolveToBaseAddress to throw for invalid address
      const { resolveToBaseAddress } = require("../../../stellar/muxed");
      resolveToBaseAddress.mockImplementation((addr: string) => {
        throw new Error("Invalid address format");
      });

      await expect(
        service.sendPayment("INVALID_M_ADDRESS", "100", "Alice", "Bob"),
      ).rejects.toThrow("Invalid destination address");
    });

    it("should handle address-based sanctions screening for muxed accounts", async () => {
      (sanctionService.checkParties as jest.Mock).mockResolvedValue(undefined);
      (sanctionService.checkPartiesByAddress as jest.Mock).mockResolvedValue(
        undefined,
      );

      const muxedAddress = "MDEST...MUXEDACCOUNT123456789ABCDEFGHIJKLMNOPQRS";
      await service.sendPayment(muxedAddress, "100", "Alice Clean", "Bob Safe");

      // Should call checkPartiesByAddress with the sender and resolved receiver addresses
      expect(sanctionService.checkPartiesByAddress).toHaveBeenCalled();
    });

    it("should throw SanctionScreeningError if address-based screening fails", async () => {
      (sanctionService.checkParties as jest.Mock).mockResolvedValue(undefined);
      const err = new (SanctionScreeningError as any)(
        "receiver",
        "GDEST...",
        "Global Arms Ltd",
        0.95,
        "OFAC",
      );
      (sanctionService.checkPartiesByAddress as jest.Mock).mockRejectedValue(
        err,
      );

      await expect(
        service.sendPayment("GDEST...", "100", "Alice Clean", "Bob Safe"),
      ).rejects.toThrow("Sanction screening blocked");
    });
  });
});
