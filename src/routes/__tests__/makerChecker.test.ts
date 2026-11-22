import { Request, Response } from "express";
import {
  submitActionProposal,
  approveActionProposal,
  rejectActionProposal,
  clearPendingActions,
  pendingActions,
  User,
} from "../makerChecker";
import { complianceRoutes } from "../compliance";

describe("Maker-Checker Compliance Workflow (#2340)", () => {
  const complianceAnalystMaker: User = {
    id: "analyst-001",
    role: "compliance_analyst",
  };

  const complianceManagerChecker: User = {
    id: "manager-002",
    role: "compliance_manager",
  };

  const regularAdminChecker: User = {
    id: "admin-003",
    role: "admin",
  };

  beforeEach(() => {
    clearPendingActions();
  });

  describe("AML Freeze & Unfreeze Proposals", () => {
    it("should allow a compliance analyst to propose freezing high-value user funds", () => {
      const { action } = submitActionProposal({
        action_type: "freeze_funds",
        payload: { userId: "user-suspect-99", amount: 5000000 },
        maker: complianceAnalystMaker,
        justification: "Suspected structuring across multiple mobile wallets",
      });

      expect(action).toBeDefined();
      expect(action.status).toBe("pending");
      expect(action.maker_id).toBe("analyst-001");
      expect(action.justification).toBe(
        "Suspected structuring across multiple mobile wallets",
      );
      expect(pendingActions.length).toBe(1);
    });

    it("should allow a compliance analyst to propose blacklisting a phone number", () => {
      const { action } = submitActionProposal({
        action_type: "blacklist_phone",
        payload: { phoneNumber: "+237670111222" },
        maker: complianceAnalystMaker,
        justification: "Phone linked to confirmed fraud ring",
      });

      expect(action.status).toBe("pending");
      expect(action.action_type).toBe("blacklist_phone");
    });
  });

  describe("Authorization Enforcement & Self-Approval Prevention", () => {
    it("CRITICAL: strictly reject maker from approving their own freeze/unfreeze action proposal (single-party approval rejection)", () => {
      const { action } = submitActionProposal({
        action_type: "freeze_funds",
        payload: { userId: "user-123" },
        maker: complianceAnalystMaker,
        justification: "High-risk AML alert",
      });

      // Attempting to approve as the same user (maker)
      expect(() => {
        approveActionProposal({
          actionId: action.id,
          checker: complianceAnalystMaker, // Same as maker!
          justification: "Self-approval attempt",
        });
      }).toThrow(/single-party approval is strictly rejected/i);

      // Verify status remains pending
      expect(action.status).toBe("pending");
    });

    it("should reject approval if checker does not have compliance_manager role", () => {
      const { action } = submitActionProposal({
        action_type: "freeze_funds",
        payload: { userId: "user-123" },
        maker: complianceAnalystMaker,
        justification: "High-risk AML alert",
      });

      // Regular admin without compliance_manager role
      expect(() => {
        approveActionProposal({
          actionId: action.id,
          checker: regularAdminChecker,
          justification: "Admin approval attempt",
        });
      }).toThrow(/compliance_manager role/i);

      expect(action.status).toBe("pending");
    });

    it("should succeed when distinct compliance_manager approves and logs audit details", () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const { action } = submitActionProposal({
        action_type: "freeze_funds",
        payload: { userId: "user-suspect-99" },
        maker: complianceAnalystMaker,
        justification: "Sanctions hit confirmed",
      });

      const { action: approvedAction, result } = approveActionProposal({
        actionId: action.id,
        checker: complianceManagerChecker,
        justification: "Reviewed evidence and confirmed freeze requirement",
      });

      expect(approvedAction.status).toBe("approved");
      expect(approvedAction.checker_id).toBe("manager-002");
      expect(approvedAction.resolved_at).toBeDefined();
      expect(result.executed).toBe(true);
      expect(result.accountFrozen).toBe(true);

      // Verify audit log call
      expect(consoleSpy).toHaveBeenCalledWith(
        "[MAKER-CHECKER AUDIT]",
        expect.objectContaining({
          event: "ACTION_APPROVED",
          actorId: "manager-002",
          makerId: "analyst-001",
          checkerId: "manager-002",
        }),
      );

      consoleSpy.mockRestore();
    });

    it("should allow compliance manager to reject a proposal", () => {
      const { action } = submitActionProposal({
        action_type: "unfreeze_funds",
        payload: { userId: "user-123" },
        maker: complianceAnalystMaker,
        justification: "Customer submitted proof of income",
      });

      const { action: rejectedAction } = rejectActionProposal({
        actionId: action.id,
        checker: complianceManagerChecker,
        justification: "Proof of income insufficient upon verification",
      });

      expect(rejectedAction.status).toBe("rejected");
      expect(rejectedAction.checker_id).toBe("manager-002");
    });
  });
});
