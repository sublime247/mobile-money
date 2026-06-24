import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { runSanctionSyncJob } from "../../jobs/sanctionSyncJob";
import { sanctionService } from "../../services/sanctionService";
import { pool } from "../../config/database";
import axios from "axios";

// Mock the database pool
jest.mock("../../config/database", () => ({
  pool: {
    connect: jest.fn<any>(),
    query: jest.fn<any>(),
  },
}));

// Mock axios
jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedPool = pool as jest.Mocked<typeof pool>;

describe("SanctionSyncJob", () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    mockClient = {
      query: jest.fn<any>().mockResolvedValue({}),
      release: jest.fn<any>(),
    };
    (mockedPool.connect as any).mockResolvedValue(mockClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should successfully run the sync job with mock data on axios error (fallback behavior)", async () => {
    (mockedAxios.get as any).mockRejectedValue(new Error("Network connection timeout"));

    await runSanctionSyncJob();

    // Verify fallback to seed sanctions
    expect(console.warn as any).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch or parse UN Consolidated List"),
    );
    expect(console.warn as any).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch or parse OFAC SDN List"),
    );

    // Verify it updates the database with seeds (4 seed records)
    expect(mockClient.query as any).toHaveBeenCalledWith("BEGIN");
    expect(mockClient.query as any).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO sanction_list"),
      expect.any(Array),
    );
    expect(mockClient.query as any).toHaveBeenCalledWith("COMMIT");
    expect(mockClient.release as any).toHaveBeenCalled();
  });

  it("should parse UN XML consolidated list successfully", async () => {
    const unXmlMock = `
      <CONSOLIDATED_LIST>
        <INDIVIDUALS>
          <INDIVIDUAL>
            <DATAID>999</DATAID>
            <FIRST_NAME>Osama</FIRST_NAME>
            <SECOND_NAME>Bin</SECOND_NAME>
            <THIRD_NAME>Laden</THIRD_NAME>
            <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
            <INDIVIDUAL_ADDRESS>
              <COUNTRY>Saudi Arabia</COUNTRY>
            </INDIVIDUAL_ADDRESS>
          </INDIVIDUAL>
        </INDIVIDUALS>
        <ENTITIES>
          <ENTITY>
            <DATAID>888</DATAID>
            <FIRST_NAME>Global Terror Corp</FIRST_NAME>
            <ENTITY_ADDRESS>
              <COUNTRY>Syria</COUNTRY>
            </ENTITY_ADDRESS>
          </ENTITY>
        </ENTITIES>
      </CONSOLIDATED_LIST>
    `;

    // UN request succeeds, OFAC fails to test mixed behavior
    (mockedAxios.get as any)
      .mockResolvedValueOnce({ data: unXmlMock })
      .mockRejectedValueOnce(new Error("OFAC service down"));

    const updates = await sanctionService.fetchSanctionUpdates();

    // The result should contain the UN records parsed, plus seed fallbacks
    const unInd = updates.find((u) => u.external_id === "UN-999");
    expect(unInd).toBeDefined();
    expect(unInd?.name).toBe("Osama Bin Laden");
    expect(unInd?.country).toBe("Saudi Arabia");
    expect(unInd?.category).toBe("Individual");

    const unEnt = updates.find((u) => u.external_id === "UN-888");
    expect(unEnt).toBeDefined();
    expect(unEnt?.name).toBe("Global Terror Corp");
    expect(unEnt?.country).toBe("Syria");
    expect(unEnt?.category).toBe("Entity");

    // The result should also contain seed fallbacks
    const seed = updates.find((u) => u.external_id === "OFAC-456");
    expect(seed).toBeDefined();
  });

  it("should parse OFAC XML SDN list successfully", async () => {
    const ofacXmlMock = `
      <sdnList>
        <sdnEntry>
          <uid>777</uid>
          <firstName>John</firstName>
          <lastName>Criminal</lastName>
          <sdnType>Individual</sdnType>
          <addressList>
            <address>
              <country>Iran</country>
            </address>
          </addressList>
        </sdnEntry>
        <sdnEntry>
          <uid>666</uid>
          <lastName>Sanctioned Company</lastName>
          <sdnType>Entity</sdnType>
        </sdnEntry>
      </sdnList>
    `;

    // UN fails, OFAC succeeds
    (mockedAxios.get as any)
      .mockRejectedValueOnce(new Error("UN service down"))
      .mockResolvedValueOnce({ data: ofacXmlMock });

    const updates = await sanctionService.fetchSanctionUpdates();

    // The result should contain the OFAC records parsed, plus seed fallbacks
    const ofacInd = updates.find((u) => u.external_id === "OFAC-777");
    expect(ofacInd).toBeDefined();
    expect(ofacInd?.name).toBe("John Criminal");
    expect(ofacInd?.country).toBe("Iran");
    expect(ofacInd?.category).toBe("Individual");

    const ofacEnt = updates.find((u) => u.external_id === "OFAC-666");
    expect(ofacEnt).toBeDefined();
    expect(ofacEnt?.name).toBe("Sanctioned Company");
    expect(ofacEnt?.category).toBe("Entity");
  });
});
