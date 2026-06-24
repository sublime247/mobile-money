import logger from "../utils/logger";
import { Request, Response, NextFunction } from "express";

// Define valid providers in uppercase
const VALID_PROVIDERS = ["MTN", "AIRTEL", "ORANGE"] as const;

/**
 * Middleware to normalize and validate provider names
 * Converts provider names to uppercase and validates against allowed providers
 */
export const normalizeProvider = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { provider } = req.body;

    // Check if provider field exists
    if (!provider) {
      return res.status(400).json({
        error: "Validation failed",
        details: [
          {
            path: "provider",
            message: "Provider field is required",
          },
        ],
      });
    }

    // Normalize provider to uppercase
    const normalizedProvider = String(provider).toUpperCase();

    // Validate against allowed providers
    if (!VALID_PROVIDERS.includes(normalizedProvider as any)) {
      return res.status(400).json({
        error: "Validation failed",
        details: [
          {
            path: "provider",
            message: `Provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
          },
        ],
      });
    }

    // Update req.body with normalized provider
    req.body.provider = normalizedProvider;

    next();
  } catch (error) {
    logger.error("Error in normalizeProvider middleware:", error);
    return res.status(500).json({
      error: "An internal server error occurred during provider normalization",
    });
  }
};
