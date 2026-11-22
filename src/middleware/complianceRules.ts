import { NextFunction, Request, Response } from "express";
import {
  complianceRulesEngine,
  ComplianceRuleResult,
} from "../services/compliance/rulesEngine";

export interface ComplianceRulesRequest extends Request {
  complianceRuleResults?: ComplianceRuleResult[];
}

export function createComplianceRulesMiddleware(
  engine = complianceRulesEngine,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const results = engine.evaluate(req.body ?? {});
    (req as ComplianceRulesRequest).complianceRuleResults = results;

    const failedRule = results.find(
      (result) => !result.passed && result.severity === "error",
    );
    if (failedRule) {
      res.status(400).json({
        error: "Compliance validation failed",
        rule: failedRule.ruleId,
        message: failedRule.message,
        results,
      });
      return;
    }

    next();
  };
}

export const complianceRulesMiddleware = createComplianceRulesMiddleware();