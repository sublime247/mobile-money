import { describe, expect, it, jest } from "@jest/globals";
import { scrubLogOutput, logSanitizerMiddleware } from "../logger";

describe("Logger PII Scrubbing (#1578)", () => {
  it("scrubs emails and phone numbers from raw log strings", () => {
    const rawLog = "Failed payment for user john.doe@example.com with phone +237677123456";
    const scrubbed = scrubLogOutput(rawLog);

    expect(scrubbed).not.toContain("john.doe@example.com");
    expect(scrubbed).not.toContain("+237677123456");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs PII parameters in JSON formatted log strings", () => {
    const jsonLog = JSON.stringify({
      level: "ERROR",
      message: "Authentication failure",
      email: "alice@domain.org",
      phoneNumber: "+14155552671",
      firstName: "Alice",
      lastName: "Smith",
    });

    const scrubbed = scrubLogOutput(jsonLog);
    const parsed = JSON.parse(scrubbed);

    expect(parsed.email).toBe("[REDACTED]");
    expect(parsed.phoneNumber).toBe("+1*****671");
    expect(parsed.firstName).toBe("[REDACTED]");
    expect(parsed.lastName).toBe("[REDACTED]");
  });

  it("sanitizes Express request object via logSanitizerMiddleware", () => {
    const req: any = {
      body: {
        email: "bob@test.com",
        phone: "+237699001122",
        firstName: "Bob",
      },
      query: {
        user_email: "bob.query@test.com",
      },
      params: {
        phone_number: "+237699001122",
      },
    };

    const next = jest.fn();
    logSanitizerMiddleware(req, {}, next);

    expect(next).toHaveBeenCalled();
    expect(req.body.email).toBe("[REDACTED]");
    expect(req.body.phone).toBe("+237*****122");
    expect(req.body.firstName).toBe("[REDACTED]");
    expect(req.query.user_email).toBe("[REDACTED]");
    expect(req.params.phone_number).toBe("+237*****122");
  });
});
