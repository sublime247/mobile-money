/**
 * /api/v1/quotes — Quote creation endpoint
 * Issue #2283
 *
 * Validates the request body strictly against the Zod QuoteCreateRequest
 * schema before delegating to business logic.  Returns HTTP 400 with a
 * structured error body on any validation failure, and HTTP 200 with a
 * quote object on success.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  quoteCreateSchema,
  formatZodErrors,
  type QuoteCreateRequest,
} from "../schemas/quoteSchema.js";

export const quotesRouter = Router();

// ---------------------------------------------------------------------------
// Validation middleware
// ---------------------------------------------------------------------------

/**
 * Strict Zod validation for POST /api/v1/quotes.
 *
 * On failure returns:
 *   HTTP 400  application/json
 *   {
 *     "error": "Validation failed",
 *     "code":  "INVALID_INPUT",
 *     "errors": [{ "field": "amount", "message": "amount must be a positive number" }]
 *   }
 */
function validateQuoteBody(req: Request, res: Response, next: NextFunction) {
  const result = quoteCreateSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: "Validation failed",
      code: "INVALID_INPUT",
      errors: formatZodErrors(result.error),
    });
    return;
  }

  // Attach parsed (validated + typed) body so downstream handlers don't
  // need to re-parse.
  (req as Request & { validatedBody: QuoteCreateRequest }).validatedBody =
    result.data;

  next();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/quotes
 *
 * Create a new FX/cross-asset quote for a mobile money transaction.
 *
 * Request body (application/json):
 *   source_asset       string  — asset the sender holds  (e.g. "KES")
 *   destination_asset  string  — asset the recipient receives (e.g. "USDC")
 *   amount             number  — positive amount denominated in source_asset
 *
 * Response 200:
 *   {
 *     "quote_id":          string,
 *     "source_asset":      string,
 *     "destination_asset": string,
 *     "source_amount":     number,
 *     "destination_amount":number,
 *     "exchange_rate":     number,
 *     "fee":               number,
 *     "expires_at":        string  // ISO 8601
 *   }
 */
quotesRouter.post("/", validateQuoteBody, (req: Request, res: Response) => {
  const body = (req as Request & { validatedBody: QuoteCreateRequest })
    .validatedBody;

  // Placeholder rate — replace with real FX service call
  const PLACEHOLDER_RATE = 1.0;
  const fee = parseFloat((body.amount * 0.01).toFixed(6)); // 1 % fee
  const destinationAmount = parseFloat(
    ((body.amount - fee) * PLACEHOLDER_RATE).toFixed(6),
  );

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min

  res.status(200).json({
    quote_id: `qte_${Date.now()}`,
    source_asset: body.source_asset,
    destination_asset: body.destination_asset,
    source_amount: body.amount,
    destination_amount: destinationAmount,
    exchange_rate: PLACEHOLDER_RATE,
    fee,
    expires_at: expiresAt,
  });
});

/**
 * GET /api/v1/quotes/:id
 *
 * Retrieve a previously created quote by ID.
 * Stub implementation — replace with DB lookup.
 */
quotesRouter.get("/:id", (req: Request, res: Response) => {
  res.status(404).json({
    error: "Quote not found",
    code: "NOT_FOUND",
    quote_id: req.params["id"],
  });
});
