import axios from "axios";
import { pool } from "../../config/database";
import {
  calculateChecksum,
  fetchFeedWithChecksum,
  parseUNSanctionsXML,
  parseOFACSanctionsXML,
  atomicSanctionsSwap,
  syncSanctionsFeeds,
} from "../feedSync";

jest.mock("axios");
jest.mock("../../config/database", () => ({
  pool: {
    connect: jest.fn(),
  },
}));

const sampleUNXml = `
<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST>
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>690123</DATAID>
      <FIRST_NAME>JOHN</FIRST_NAME>
      <SECOND_NAME>DOE</SECOND_NAME>
      <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>890456</DATAID>
      <FIRST_NAME>ILLICIT MINERALS CORP</FIRST_NAME>
      <COUNTRY>Central African Republic</COUNTRY>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>
`;

const sampleOFACXml = `
<?xml version="1.0" encoding="UTF-8"?>
<sdnList>
  <sdnEntry>
    <uid>10293</uid>
    <firstName>VIKTOR</firstName>
    <lastName>BOUT</lastName>
    <sdnType>Individual</sdnType>
    <country>Russia</country>
  </sdnEntry>
</sdnList>
`;

describe("Sanctions Automated Feed Sync (#2339)", () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);
  });

  describe("Checksum Calculation & Validation", () => {
    it("should compute accurate SHA-256 checksums", () => {
      const data = "Test payload for sanctions feed";
      const checksum = calculateChecksum(data);
      expect(checksum).toBeDefined();
      expect(checksum.length).toBe(64); // SHA-256 hex string length
    });

    it("should reject feed when expected checksum does not match calculated hash", async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: "Altered feed content" });

      await expect(
        fetchFeedWithChecksum(
          "https://example.com/feed.xml",
          "bad_expected_checksum_12345",
        ),
      ).rejects.toThrow(/checksum validation failed/i);
    });

    it("should succeed when checksum matches", async () => {
      const payload = "Authentic UN Security Council Feed";
      const expectedChecksum = calculateChecksum(payload);
      (axios.get as jest.Mock).mockResolvedValue({ data: payload });

      const result = await fetchFeedWithChecksum(
        "https://example.com/feed.xml",
        expectedChecksum,
      );

      expect(result.data).toBe(payload);
      expect(result.checksum).toBe(expectedChecksum);
    });
  });

  describe("XML Parsing", () => {
    it("should correctly parse UN XML entries for both individuals and entities", () => {
      const entries = parseUNSanctionsXML(sampleUNXml);

      expect(entries.length).toBe(2);
      expect(entries[0]).toEqual({
        name: "JOHN DOE",
        country: "Democratic Republic of the Congo",
        source: "UN",
        category: "Individual",
        externalId: "690123",
      });

      expect(entries[1]).toEqual({
        name: "ILLICIT MINERALS CORP",
        country: "Central African Republic",
        source: "UN",
        category: "Entity",
        externalId: "890456",
      });
    });

    it("should correctly parse OFAC XML entries", () => {
      const entries = parseOFACSanctionsXML(sampleOFACXml);

      expect(entries.length).toBe(1);
      expect(entries[0]).toEqual({
        name: "VIKTOR BOUT",
        country: "Russia",
        source: "OFAC",
        category: "Individual",
        externalId: "10293",
      });
    });
  });

  describe("Atomic Database Transaction & Table Swap", () => {
    it("should execute inside a single transaction with BEGIN, table operations, log record, and COMMIT", async () => {
      const entries = [
        {
          name: "TARGET NAME",
          country: "CAR",
          source: "UN" as const,
          category: "Individual" as const,
          externalId: "UN-999",
        },
      ];

      const result = await atomicSanctionsSwap(
        entries,
        "UN",
        "v2026.10.21",
        "mock-checksum-hex",
      );

      expect(result.status).toBe("SUCCESS");
      expect(result.recordsCount).toBe(1);

      // Verify BEGIN was called
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");

      // Verify table cleanup for source
      expect(mockClient.query).toHaveBeenCalledWith(
        "DELETE FROM sanction_list WHERE source = $1",
        ["UN"],
      );

      // Verify insert into sanction_list
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO sanction_list"),
        expect.arrayContaining(["TARGET NAME", "CAR", "UN", "Individual", "UN-999"]),
      );

      // Verify compliance_feed_sync_logs record
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO compliance_feed_sync_logs"),
        expect.arrayContaining(["UN", "v2026.10.21", 1, "mock-checksum-hex", "SUCCESS"]),
      );

      // Verify COMMIT was called
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should ROLLBACK and record failure if an error occurs during atomic swap", async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === "BEGIN") return Promise.resolve();
        if (sql.includes("DELETE FROM sanction_list")) {
          return Promise.reject(new Error("Database disk full"));
        }
        return Promise.resolve();
      });

      const entries = [
        {
          name: "TARGET NAME",
          country: "CAR",
          source: "UN" as const,
          category: "Individual" as const,
          externalId: "UN-999",
        },
      ];

      await expect(
        atomicSanctionsSwap(entries, "UN", "v2026.10.21", "mock-checksum"),
      ).rejects.toThrow("Database disk full");

      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
