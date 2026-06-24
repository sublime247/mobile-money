import { Request, Response, NextFunction } from "express";
import { NETWORK_PREFIXES, type MobileNetworkName } from "../constants/networkPrefixes";

const LOCAL_PREFIX_CACHE = Object.entries(NETWORK_PREFIXES).reduce(
  (current, [prefix, network]) => {
    const countryCode = prefix.slice(0, 3);
    const localPrefix = prefix.length > 3 ? prefix.slice(3) : prefix;
    current[localPrefix] = network;
    return current;
  },
  {} as Record<string, MobileNetworkName>,
);

const sortedNetworkKeys = Object.keys(NETWORK_PREFIXES).sort((a, b) => b.length - a.length);
const sortedLocalKeys = Object.keys(LOCAL_PREFIX_CACHE).sort((a, b) => b.length - a.length);

function normalizePhoneNumber(rawPhone: string): string {
  let digits = rawPhone.trim().replace(/\D/g, "");

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("0") && digits.length > 1) {
    digits = digits.slice(1);
  }

  return digits;
}

function resolveNetworkForDigits(phoneDigits: string): MobileNetworkName | null {
  for (const prefix of sortedNetworkKeys) {
    if (phoneDigits.startsWith(prefix)) {
      return NETWORK_PREFIXES[prefix];
    }
  }

  for (const localPrefix of sortedLocalKeys) {
    if (phoneDigits.startsWith(localPrefix)) {
      return LOCAL_PREFIX_CACHE[localPrefix];
    }
  }

  return null;
}

/**
 * Middleware to validate destination mobile network prefixes.
 *
 * This middleware extracts destinationPhone or phoneNumber from req.body,
 * normalizes country-code and local trunk prefixes, resolves the network from
 * configured prefixes, and attaches req.body.resolvedNetwork when valid.
 */
export const validateNetworkMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const rawPhone =
      typeof req.body.destinationPhone === "string"
        ? req.body.destinationPhone
        : typeof req.body.phoneNumber === "string"
        ? req.body.phoneNumber
        : undefined;

    if (!rawPhone) {
      return res.status(400).json({
        error: "Validation failed",
        details: [
          {
            path: "destinationPhone or phoneNumber",
            message: "Destination phone number is required",
          },
        ],
      });
    }

    const normalized = normalizePhoneNumber(rawPhone);
    if (!normalized || normalized.length < 4) {
      return res.status(400).json({
        error: "Validation failed",
        details: [
          {
            path: "destinationPhone or phoneNumber",
            message: "Invalid phone number format",
          },
        ],
      });
    }

    const resolvedNetwork = resolveNetworkForDigits(normalized);
    if (!resolvedNetwork) {
      return res.status(400).json({
        error: "Validation failed",
        details: [
          {
            path: "destinationPhone or phoneNumber",
            message:
              "Unsupported destination network prefix. Supported networks are MTN, AIRTEL, and ORANGE.",
          },
        ],
      });
    }

    (req.body as any).resolvedNetwork = resolvedNetwork;
    next();
  } catch (error) {
    console.error("Error in validateNetworkMiddleware:", error);
    return res.status(500).json({
      error: "An internal server error occurred during network validation",
    });
  }
};
