import { Router } from "express";
import {
  depositHandler,
  withdrawHandler,
  getTransactionHandler,
  updateNotesHandler,
  searchTransactionsHandler,
} from "../controllers/transactionController";
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";
import { authenticateToken } from "../middleware/auth";
import { validateTransaction } from "../middleware/validateTransaction";
import {
  requireOwnDataAccess,
  requireReadAccess,
  requireWriteAccess,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
} from "../middleware/rbac";

export const transactionRoutesWithRBAC = Router();

// Deposit route - requires write access to own data
transactionRoutesWithRBAC.post(
  "/deposit",
  authenticateToken,
  requireOwnDataAccess("write"),
  TimeoutPresets.long,
  haltOnTimedout,
  validateTransaction,
  depositHandler,
);

// Withdraw route - requires write access to own data
transactionRoutesWithRBAC.post(
  "/withdraw",
  authenticateToken,
  requireOwnDataAccess("write"),
  TimeoutPresets.long,
  haltOnTimedout,
  validateTransaction,
  withdrawHandler,
);

// Get transaction - requires read access (own or all)
transactionRoutesWithRBAC.get(
  "/:id",
  authenticateToken,
  requireReadAccess,
  TimeoutPresets.quick,
  haltOnTimedout,
  getTransactionHandler,
);

// Update notes - requires write access to own data
transactionRoutesWithRBAC.patch(
  "/:id/notes",
  authenticateToken,
  requireOwnDataAccess("write"),
  TimeoutPresets.quick,
  haltOnTimedout,
  updateNotesHandler,
);

// Search transactions - requires read access to all data (admin) or own data
transactionRoutesWithRBAC.get(
  "/search",
  authenticateToken,
  requireAnyPermission(["read:all", "read:own"]),
  TimeoutPresets.quick,
  haltOnTimedout,
  searchTransactionsHandler,
);

// Admin-only routes

// Get all transactions (admin only)
transactionRoutesWithRBAC.get(
  "/admin/all",
  authenticateToken,
  requireAdmin,
  TimeoutPresets.quick,
  haltOnTimedout,
  async (req, res) => {
    // Admin can see all transactions
    // Implementation would go here
    res.json({ message: "Admin access to all transactions" });
  },
);

// Delete transaction (admin only)
transactionRoutesWithRBAC.delete(
  "/admin/:id",
  authenticateToken,
  requirePermission("delete:all"),
  TimeoutPresets.quick,
  haltOnTimedout,
  async (req, res) => {
    // Admin can delete any transaction
    // Implementation would go here
    res.json({ message: "Admin deleted transaction" });
  },
);

// Export controller with RBAC context
export const transactionControllerWithRBAC = {
  // Example of how to use RBAC context in controllers
  async getTransactions(req: any, res: any) {
    // req.userRole and req.userPermissions are available from RBAC middleware
    const { userRole, userPermissions, jwtUser } = req;

    if (userRole === "admin" && userPermissions?.includes("read:all")) {
      // Admin can see all transactions
      // const allTransactions = await getAllTransactions();
      res.json({ message: "All transactions (admin view)" });
    } else if (userPermissions?.includes("read:own")) {
      // User can see their own transactions
      // const userTransactions = await getUserTransactions(jwtUser.userId);
      res.json({ message: "User transactions (own view)" });
    } else {
      res.status(403).json({ error: "Insufficient permissions" });
    }
  },
};

// Helper function to check if user can access specific resource
function canAccessResource(req: any, resourceUserId: string): boolean {
  const { userRole, userPermissions, jwtUser } = req;

  // Admin can access everything
  if (userRole === "admin") return true;

  // User can access their own resources
  if (jwtUser?.userId === resourceUserId) return true;

  // Check for specific permissions
  if (userPermissions?.includes("read:all")) return true;

  return false;
}

export { canAccessResource };
