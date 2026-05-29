import { Request, Response, NextFunction } from "express";
import { enforceTransactionGeofencing } from "../../middleware/geoFencing";
import { geolocationService, LocationMetadata } from "../../services/geolocation";

// Mock the geolocation service
jest.mock("../../services/geolocation");

// Mock the extractClientIp function
jest.mock("../../middleware/geolocate", () => ({
  extractClientIp: jest.fn((req: Request) => req.ip || "203.0.113.1"),
}));

describe("enforceTransactionGeofencing middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    // Reset environment variables
    delete process.env.GEO_FENCING_ENABLED;
    delete process.env.GEO_SANCTIONED_COUNTRIES;
    delete process.env.GEO_SUPPORTED_REGIONS;
    delete process.env.GEO_WHITELIST_IPS;
    delete process.env.GEO_ALLOW_UNKNOWN_LOCATIONS;
    delete process.env.GEO_FENCING_FAIL_OPEN;
    delete process.env.GEO_LOG_ALLOWED_TRANSACTIONS;

    // Setup mocks
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      ip: "203.0.113.1",
      path: "/api/transactions/deposit",
      method: "POST",
      clientIp: "203.0.113.1",
      geoLocation: undefined,
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
    };

    mockNext = jest.fn();

    // Clear all mocks
    jest.clearAllMocks();
  });

  describe("Geofencing enabled/disabled", () => {
    it("should allow transaction when geofencing is disabled", async () => {
      process.env.GEO_FENCING_ENABLED = "false";

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("should enforce geofencing when enabled (default)", async () => {
      const mockGeoLocation: LocationMetadata = {
        country: "United States",
        countryCode: "US",
        city: "New York",
        isp: "Test ISP",
        lat: 40.7128,
        lon: -74.006,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("IP Whitelist", () => {
    it("should allow transaction from whitelisted IP", async () => {
      process.env.GEO_WHITELIST_IPS = "203.0.113.1,198.51.100.20";
      mockRequest.ip = "203.0.113.1";

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("should enforce geofencing for non-whitelisted IP", async () => {
      process.env.GEO_WHITELIST_IPS = "198.51.100.20";
      process.env.GEO_SANCTIONED_COUNTRIES = "IR";
      mockRequest.ip = "203.0.113.1";

      const mockGeoLocation: LocationMetadata = {
        country: "Iran",
        countryCode: "IR",
        city: "Tehran",
        isp: "Test ISP",
        lat: 35.6892,
        lon: 51.389,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          countryCode: "IR",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("Sanctioned Countries", () => {
    it("should block transaction from default sanctioned country (Iran)", async () => {
      const mockGeoLocation: LocationMetadata = {
        country: "Iran",
        countryCode: "IR",
        city: "Tehran",
        isp: "Test ISP",
        lat: 35.6892,
        lon: 51.389,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          message: expect.stringContaining("Iran"),
          countryCode: "IR",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should block transaction from custom sanctioned country", async () => {
      process.env.GEO_SANCTIONED_COUNTRIES = "XX,YY,ZZ";

      const mockGeoLocation: LocationMetadata = {
        country: "Test Country",
        countryCode: "XX",
        city: "Test City",
        isp: "Test ISP",
        lat: 0,
        lon: 0,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          countryCode: "XX",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow transaction from non-sanctioned country", async () => {
      const mockGeoLocation: LocationMetadata = {
        country: "United States",
        countryCode: "US",
        city: "New York",
        isp: "Test ISP",
        lat: 40.7128,
        lon: -74.006,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });
  });

  describe("Supported Regions (Whitelist Mode)", () => {
    it("should allow transaction from supported region", async () => {
      process.env.GEO_SUPPORTED_REGIONS = "CM,UG,RW,GH,KE";

      const mockGeoLocation: LocationMetadata = {
        country: "Kenya",
        countryCode: "KE",
        city: "Nairobi",
        isp: "Test ISP",
        lat: -1.2921,
        lon: 36.8219,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("should block transaction from unsupported region when whitelist is configured", async () => {
      process.env.GEO_SUPPORTED_REGIONS = "CM,UG,RW,GH,KE";

      const mockGeoLocation: LocationMetadata = {
        country: "United States",
        countryCode: "US",
        city: "New York",
        isp: "Test ISP",
        lat: 40.7128,
        lon: -74.006,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          message: expect.stringContaining("not supported"),
          countryCode: "US",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("Unknown Location Handling", () => {
    it("should allow transaction from unknown location by default", async () => {
      const mockGeoLocation: LocationMetadata = {
        country: "Unknown",
        countryCode: "XX",
        city: "Unknown",
        isp: "Unknown",
        lat: 0,
        lon: 0,
        status: "unknown",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("should block transaction from unknown location when configured", async () => {
      process.env.GEO_ALLOW_UNKNOWN_LOCATIONS = "false";

      const mockGeoLocation: LocationMetadata = {
        country: "Unknown",
        countryCode: "XX",
        city: "Unknown",
        isp: "Unknown",
        lat: 0,
        lon: 0,
        status: "unknown",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          message: expect.stringContaining("Unable to determine"),
          countryCode: "XX",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("Geolocation Lookup Fallback", () => {
    it("should lookup geolocation if not already attached", async () => {
      const mockGeoLocation: LocationMetadata = {
        country: "United States",
        countryCode: "US",
        city: "New York",
        isp: "Test ISP",
        lat: 40.7128,
        lon: -74.006,
        status: "resolved",
      };

      mockRequest.geoLocation = undefined;
      (geolocationService.lookup as jest.Mock).mockResolvedValue(mockGeoLocation);

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(geolocationService.lookup).toHaveBeenCalledWith("203.0.113.1");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should fail open when geolocation lookup fails (default)", async () => {
      mockRequest.geoLocation = undefined;
      (geolocationService.lookup as jest.Mock).mockRejectedValue(
        new Error("Lookup failed")
      );

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("should fail closed when geolocation lookup fails and configured", async () => {
      process.env.GEO_FENCING_FAIL_OPEN = "false";
      mockRequest.geoLocation = undefined;
      (geolocationService.lookup as jest.Mock).mockRejectedValue(
        new Error("Lookup failed")
      );

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          message: expect.stringContaining("Unable to verify"),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should fail open on unexpected middleware error (default)", async () => {
      // Force an error by making geoLocation undefined and lookup to throw
      mockRequest.geoLocation = undefined;
      (geolocationService.lookup as jest.Mock).mockImplementation(() => {
        throw new Error("Unexpected error");
      });

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
    });

    it("should fail closed on unexpected middleware error when configured", async () => {
      process.env.GEO_FENCING_FAIL_OPEN = "false";
      mockRequest.geoLocation = undefined;
      (geolocationService.lookup as jest.Mock).mockImplementation(() => {
        throw new Error("Unexpected error");
      });

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCING_ERROR",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("Priority Order", () => {
    it("should check sanctioned countries before supported regions", async () => {
      // Configure both sanctioned and supported regions
      process.env.GEO_SANCTIONED_COUNTRIES = "IR";
      process.env.GEO_SUPPORTED_REGIONS = "IR,US,UK"; // IR is in both lists

      const mockGeoLocation: LocationMetadata = {
        country: "Iran",
        countryCode: "IR",
        city: "Tehran",
        isp: "Test ISP",
        lat: 35.6892,
        lon: 51.389,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      // Should be blocked due to sanctions, not allowed due to supported regions
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "GEOFENCE_BLOCKED",
          message: expect.stringContaining("regulatory restrictions"),
          countryCode: "IR",
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("Case Insensitivity", () => {
    it("should handle lowercase country codes", async () => {
      process.env.GEO_SANCTIONED_COUNTRIES = "ir,kp,sy";

      const mockGeoLocation: LocationMetadata = {
        country: "Iran",
        countryCode: "IR",
        city: "Tehran",
        isp: "Test ISP",
        lat: 35.6892,
        lon: 51.389,
        status: "resolved",
      };

      mockRequest.geoLocation = mockGeoLocation;

      await enforceTransactionGeofencing(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});
