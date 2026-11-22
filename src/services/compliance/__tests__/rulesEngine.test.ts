import { NextFunction, Request, Response } from "express";
import {
  ComplianceRulesEngine,
  ComplianceRule,
} from "../rulesEngine";
import { createComplianceRulesMiddleware } from "../../../middleware/complianceRules";

const rules: ComplianceRule[] = [
  {
    id: "always_pass",
    evaluate: () => ({
      ruleId: "always_pass",
      passed: true,
      severity: "error",
    }),
  },
  {
    id: "always_fail",
    evaluate: () => ({
      ruleId: "always_fail",
      passed: false,
      severity: "error",
      message: "Rule failed",
    }),
  },
];

describe("ComplianceRulesEngine", () => {
  const originalRules = process.env.COMPLIANCE_RULES;

  afterEach(() => {
    if (originalRules === undefined) {
      delete process.env.COMPLIANCE_RULES;
    } else {
      process.env.COMPLIANCE_RULES = originalRules;
    }
  });

  it("returns explicit results for every registered rule", () => {
    const results = new ComplianceRulesEngine(rules).evaluate({});

    expect(results).toEqual([
      { ruleId: "always_pass", passed: true, severity: "error" },
      {
        ruleId: "always_fail",
        passed: false,
        severity: "error",
        message: "Rule failed",
      },
    ]);
  });

  it("selects configured rules by id", () => {
    process.env.COMPLIANCE_RULES = "always_pass";

    expect(new ComplianceRulesEngine(rules).evaluate({})).toHaveLength(1);
    expect(new ComplianceRulesEngine(rules).evaluate({})[0].ruleId).toBe(
      "always_pass",
    );
  });

  it("blocks an error result and returns all rule results", () => {
    const next = jest.fn() as NextFunction;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const req = { body: {} } as Request;

    createComplianceRulesMiddleware(new ComplianceRulesEngine(rules))(
      req,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Compliance validation failed",
        rule: "always_fail",
        results: expect.any(Array),
      }),
    );
  });

  it("continues when all default rules pass", () => {
    const next = jest.fn() as NextFunction;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const req = {
      body: { amount: 100, userId: "user-1", provider: "mtn" },
    } as Request;

    createComplianceRulesMiddleware(new ComplianceRulesEngine())(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as Request & { complianceRuleResults?: unknown[] }).complianceRuleResults)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "positive_amount", passed: true }),
      ]));
    expect(res.status).not.toHaveBeenCalled();
  });
});