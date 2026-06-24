import logger from "../utils/logger";
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { resolveToBaseAddress } from "../stellar/muxed";

/**
 * Validate Stellar address format (G-address or M-address).
 * Both formats are accepted, but M-addresses must be valid muxed accounts.
 */
function validateStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") {
    return false;
  }
  
  try {
    resolveToBaseAddress(address);
    return true;
  } catch {
    return false;
  }
}

const transactionSchema = z.object({
  amount: z.number().positive({ message: "Amount must be a positive number" }),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, { message: "Invalid phone number format" }),
  provider: z.enum(["MTN", "AIRTEL", "ORANGE"], {
    message: "Provider must be one of: MTN, AIRTEL, ORANGE",
  }),
  stellarAddress: z
    .string()
    .refine(validateStellarAddress, { message: "Invalid Stellar address format (must be valid G-address or M-address)" }),
  userId: z.string().nonempty({ message: "userId is required" }),
});

export const validateTransaction = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    transactionSchema.parse(req.body);
    next();
  } catch (err: unknown) {
    // Check if the error is actually a Zod validation error
    if (err instanceof z.ZodError) {
      console.log("Validation error:", err.issues);

      return res.status(400).json({
        error: "Validation failed",
        details: err.issues,
      });
    }

    // Fallback for non-Zod errors
    logger.error("Unexpected validation error:", err);
    return res.status(500).json({
      error: "An internal server error occurred during validation",
    });
  }
};
