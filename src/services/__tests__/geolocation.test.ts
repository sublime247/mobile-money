import { adminGeofenceMiddleware, geolocationService } from "../geolocation";
import { Request, Response } from "express";
import geoip from "geoip-lite";

jest.mock("geoip-lite");

describe("Geolocation Service & Middleware", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe("lookup", () => {
    it("should return resolved location metadata using geoip-lite", async () => {
      const mockGeo = {
        country: "US",
        city: "New York",
        ll: [40.7128, -74.0060],
      };
      (geoip.lookup as jest.Mock).mockReturnValue(mockGeo);

      const result = await geolocationService.lookup("8.8.8.8");
      expect(result.countryCode).toBe("US");
      expect(result.status).toBe("resolved");
    });
  });

  describe("adminGeofenceMiddleware", () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let nextFunction: jest.Mock;

    beforeEach(() => {
      mockRequest = {
        ip: "8.8.8.8",
        headers: {},
      };
      mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      nextFunction = jest.fn();
    });

    it("should allow request if IP is whitelisted", async () => {
      process.env.ADMIN_WHITELIST_IPS = "8.8.8.8";
      await adminGeofenceMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        nextFunction
      );
      expect(nextFunction).toHaveBeenCalled();
    });

    it("should allow request if country is allowed", async () => {
      process.env.ADMIN_WHITELIST_IPS = "";
      process.env.ALLOWED_ADMIN_COUNTRIES = "US,CA";
      const mockGeo = {
        country: "US",
        city: "New York",
        ll: [40.7128, -74.0060],
      };
      (geoip.lookup as jest.Mock).mockReturnValue(mockGeo);

      await adminGeofenceMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        nextFunction
      );
      expect(nextFunction).toHaveBeenCalled();
    });

    it("should block request if country is not allowed", async () => {
      process.env.ADMIN_WHITELIST_IPS = "";
      process.env.ALLOWED_ADMIN_COUNTRIES = "CA";
      const mockGeo = {
        country: "US",
        city: "New York",
        ll: [40.7128, -74.0060],
      };
      (geoip.lookup as jest.Mock).mockReturnValue(mockGeo);

      await adminGeofenceMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        nextFunction
      );
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Forbidden" })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });
});
