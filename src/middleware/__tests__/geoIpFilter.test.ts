import type { Request, Response } from "express";
import { getGeoReader } from "../../auth/geo";
import logger from "../../utils/logger";
import { geoIpFilter } from "../geoIpFilter";

jest.mock("../../auth/geo", () => ({ getGeoReader: jest.fn() }));

describe("payment GeoIP filter", () => {
  const originalPath = process.env.MAXMIND_GEOIP_DB_PATH;
  const lookup = jest.fn();

  beforeEach(() => {
    process.env.MAXMIND_GEOIP_DB_PATH = "/fixture/GeoLite2-City.mmdb";
    jest.mocked(getGeoReader).mockResolvedValue({ get: lookup });
  });

  afterAll(() => {
    if (originalPath === undefined) delete process.env.MAXMIND_GEOIP_DB_PATH;
    else process.env.MAXMIND_GEOIP_DB_PATH = originalPath;
  });

  it.each([
    ["203.0.113.10", "NG", true],
    ["203.0.113.20", "IR", false],
    ["203.0.113.30", "MM", false],
  ])(
    "checks the resolved country for %s (%s)",
    async (ip, country, allowed) => {
      lookup.mockReturnValue({
        country: { iso_code: country },
        location: { latitude: 12, longitude: 34 },
      });
      const warn = jest.spyOn(logger, "warn");
      const req = {
        ip,
        headers: { "x-forwarded-for": "198.51.100.9" },
      } as unknown as Request;
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      try {
        await geoIpFilter(req, response as unknown as Response, next);
        expect(lookup).toHaveBeenLastCalledWith(ip);
        if (allowed) {
          expect(next).toHaveBeenCalledTimes(1);
          expect(response.status).not.toHaveBeenCalled();
        } else {
          expect(next).not.toHaveBeenCalled();
          expect(response.status).toHaveBeenCalledWith(403);
          expect(warn).toHaveBeenCalledWith(
            "Payment blocked by geographic restriction",
            {
              ip,
              countryCode: country,
              coordinates: [12, 34],
              timestamp: expect.any(String),
            },
          );
        }
      } finally {
        warn.mockRestore();
      }
    },
  );
});
