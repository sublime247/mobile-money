import { Router } from "express";
import { setApiVersion } from "../../middleware/apiVersion";

export const transactionRoutesV2 = Router();

/**
 * V2 Transaction Routes (Future)
 *
 * BREAKING CHANGES from v1:
 * - New response format with nested data
 * - Transaction states instead of simple status
 * - Webhook events for transaction lifecycle
 * - Advanced filtering and pagination
 *
 * Note: These are stubs for v2 development.
 * Implement after v2 specification is finalized.
 */

// NEW in v2: Enhanced deposit with metadata
transactionRoutesV2.post("/deposit", setApiVersion("v2"), (req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    message: "V2 API is coming soon",
    version: "v2",
  });
});

// NEW in v2: Enhanced withdrawal with webhooks
transactionRoutesV2.post("/withdraw", setApiVersion("v2"), (req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    message: "V2 API is coming soon",
    version: "v2",
  });
});

// ENHANCED in v2: Better transaction details
transactionRoutesV2.get("/:id", setApiVersion("v2"), (req, res) => {
  res.status(501).json({
    error: "Not Implemented",
    message: "V2 API is coming soon",
    version: "v2",
  });
});

// NEW in v2: Advanced search with filters
transactionRoutesV2.get("/search", setApiVersion("v2"), (req, res) => {
  // Query params in v2:
  // - state (pending, completed, failed)
  // - date_from, date_to
  // - amount_min, amount_max
  // - sort_by, sort_order
  // - limit, offset
  res.status(501).json({
    error: "Not Implemented",
    message: "V2 API is coming soon",
    version: "v2",
  });
});

// NEW in v2: Webhook subscriptions for transactions
transactionRoutesV2.post("/webhooks", setApiVersion("v2"), (req, res) => {
  // Subscribe to: transaction.created, transaction.completed, transaction.failed
  res.status(501).json({
    error: "Not Implemented",
    message: "V2 API is coming soon",
    version: "v2",
  });
});
