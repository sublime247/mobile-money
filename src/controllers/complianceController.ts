/**
 * Compliance Controller — Travel Rule check endpoint.
 *
 * POST /api/v1/compliance/travel-rule/check
 * Determines whether a given amount (in any supported currency) triggers the
 * FATF Travel Rule threshold and, if so, captures the required identity data.
 *
 * This is the programmatic entry-point for callers that need to run a
 * compliance check before (or independently of) a deposit transaction.
 */

import { Request, Response } from "express";
import { z } from "zod";
import {
  travelRuleService,
  TRAVEL_RULE_THRESHOLD_USD,
  TravelRuleInput,
} from "../compliance/travelRule";

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const partySchema = z.object({
  name: z.string().min(1),
  account: z.string().min(1),
  address: z.string().optional(),
  dob: z.string().optional(),
  idNumber: z.string().optional(),
});

const checkSchema = z.object({
  transactionId: z.string().min(1),
  /** Amount in USD (or the currency field below). */
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  sender: partySchema,
  receiver: partySchema,
  originatingVasp: z.string().optional(),
  beneficiaryVasp: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/compliance/travel-rule/check
 *
 * Body: TravelRuleInput (amount in USD)
 *
 * Response:
 *   { applies: false }                          — below threshold, no action
 *   { applies: true, record: TravelRuleRecord } — captured and stored
 */
export async function travelRuleCheckHandler(
  req: Request,
  res: Response,
): Promise<Response> {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const input: TravelRuleInput = parsed.data;

  if (!travelRuleService.applies(input.amount)) {
    return res.json({
      applies: false,
      threshold: TRAVEL_RULE_THRESHOLD_USD,
      message: `Amount ${input.amount} ${input.currency} is below the Travel Rule threshold of $${TRAVEL_RULE_THRESHOLD_USD}`,
    });
  }

  try {
    const record = await travelRuleService.capture(input);
    return res.status(201).json({
      applies: true,
      threshold: TRAVEL_RULE_THRESHOLD_USD,
      record: {
        id: record.id,
        transactionId: record.transactionId,
        amount: record.amount,
        currency: record.currency,
        createdAt: record.createdAt,
      },
    });
  } catch (err) {
    console.error(
      "[compliance] travel-rule check failed:",
      err instanceof Error ? err.message : err,
    );
    return res.status(500).json({ error: "Travel Rule check failed" });
  }
}
