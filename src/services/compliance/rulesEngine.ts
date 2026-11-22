export type ComplianceRuleSeverity = "error" | "warning";

export interface ComplianceRuleContext {
  amount?: unknown;
  userId?: unknown;
  provider?: unknown;
}

export interface ComplianceRuleResult {
  ruleId: string;
  passed: boolean;
  severity: ComplianceRuleSeverity;
  message?: string;
}

export interface ComplianceRule {
  id: string;
  severity?: ComplianceRuleSeverity;
  evaluate(context: ComplianceRuleContext): ComplianceRuleResult;
}

const supportedProviders = new Set(["mtn", "airtel", "orange"]);

function isPositiveAmount(amount: unknown): boolean {
  if (typeof amount === "number") {
    return Number.isFinite(amount) && amount > 0;
  }

  if (typeof amount === "string" && amount.trim() !== "") {
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed > 0;
  }

  return false;
}

export const defaultComplianceRules: ComplianceRule[] = [
  {
    id: "positive_amount",
    evaluate: (context) => ({
      ruleId: "positive_amount",
      passed: isPositiveAmount(context.amount),
      severity: "error",
      message: "Amount must be a positive number",
    }),
  },
  {
    id: "user_id_present",
    evaluate: (context) => ({
      ruleId: "user_id_present",
      passed: typeof context.userId === "string" && context.userId.trim().length > 0,
      severity: "error",
      message: "userId is required",
    }),
  },
  {
    id: "supported_provider",
    evaluate: (context) => ({
      ruleId: "supported_provider",
      passed: typeof context.provider === "string" && supportedProviders.has(context.provider.toLowerCase()),
      severity: "error",
      message: "Provider is not supported",
    }),
  },
];

function configuredRuleIds(): string[] | undefined {
  const configured = process.env.COMPLIANCE_RULES?.trim();
  if (!configured) return undefined;

  return configured
    .split(",")
    .map((ruleId) => ruleId.trim())
    .filter(Boolean);
}

export class ComplianceRulesEngine {
  private readonly rules: ComplianceRule[];

  constructor(rules: ComplianceRule[] = defaultComplianceRules) {
    const selectedRuleIds = configuredRuleIds();
    this.rules = selectedRuleIds
      ? rules.filter((rule) => selectedRuleIds.includes(rule.id))
      : rules;
  }

  evaluate(context: ComplianceRuleContext): ComplianceRuleResult[] {
    return this.rules.map((rule) => {
      const result = rule.evaluate(context);
      return {
        ...result,
        ruleId: rule.id,
        severity: result.severity ?? rule.severity ?? "error",
      };
    });
  }
}

export const complianceRulesEngine = new ComplianceRulesEngine();