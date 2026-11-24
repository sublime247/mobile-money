import { NextFunction, Request, Response } from "express";
import { createHoneypotValidator } from "../honeypotValidator";

describe("honeypotValidator", () => {
  const makeRequest = (company_fax?: string) =>
    ({
      body: company_fax === undefined ? {} : { company_fax },
      headers: {
        "x-forwarded-for": "198.51.100.200",
        "x-real-ip": "198.51.100.201",
      },
      ip: "203.0.113.10",
      originalUrl: "/pay/token/process",
      socket: { remoteAddress: "203.0.113.10" },
    }) as unknown as Request;

  const makeResponse = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    return res;
  };

  it("passes through when the honeypot field is empty", async () => {
    const blacklist = jest.fn();
    const next = jest.fn() as NextFunction;

    await createHoneypotValidator(blacklist)(makeRequest(" "), makeResponse(), next);

    expect(next).toHaveBeenCalledWith();
    expect(blacklist).not.toHaveBeenCalled();
  });

  it("blacklists a populated honeypot and returns fake success without continuing", async () => {
    const blacklist = jest.fn().mockResolvedValue(undefined);
    const res = makeResponse();
    const next = jest.fn() as NextFunction;

    await createHoneypotValidator(blacklist)(makeRequest("bot"), res, next);

    expect(blacklist).toHaveBeenCalledWith("203.0.113.10");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Payment initiated successfully" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("detects non-string populated honeypot values", async () => {
    const blacklist = jest.fn().mockResolvedValue(undefined);
    const res = makeResponse();
    const next = jest.fn() as NextFunction;
    const req = makeRequest() as Request;
    req.body.company_fax = ["bot"];

    await createHoneypotValidator(blacklist)(req, res, next);

    expect(blacklist).toHaveBeenCalledWith("203.0.113.10");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes blacklist failures to Express error handling", async () => {
    const error = new Error("Redis unavailable");
    const next = jest.fn() as NextFunction;

    await createHoneypotValidator(jest.fn().mockRejectedValue(error))(
      makeRequest("bot"),
      makeResponse(),
      next,
    );

    expect(next).toHaveBeenCalledWith(error);
  });
});
