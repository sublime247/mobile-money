import { NextFunction, Request, Response } from "express";
import { isStrictStellarGAddress } from "../utils/stellarAddressValidator";

type StellarAddressRequest = Request<{ address?: string }>;

export const validateStellarAddressMiddleware = (
  req: StellarAddressRequest,
  res: Response,
  next: NextFunction,
) => {
  const { address } = req.params;

  if (!isStrictStellarGAddress(address)) {
    return res.status(400).json({
      error: "Validation failed",
      details: [
        {
          path: "address",
          message: "Invalid Stellar G-address",
        },
      ],
    });
  }

  next();
};
