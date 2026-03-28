import { Router, Request, Response, NextFunction } from "express";
import { ValidationError, NotFoundError, BusinessLogicError } from "../utils/errors";
import { ERROR_CODES } from "../constants/errorCodes";

const router = Router();

// Example: Validation error
router.post("/transfer", (req: Request, res: Response, next: NextFunction) => {
  const { phoneNumber, amount } = req.body;

  if (!phoneNumber) {
    return next(
      new ValidationError(
        "Phone number is required",
        ERROR_CODES.MISSING_FIELD,
        { field: "phoneNumber" },
      ),
    );
  }

  if (!/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
    return next(
      new ValidationError(
        "Invalid phone format",
        ERROR_CODES.INVALID_PHONE_FORMAT,
        { received: phoneNumber },
      ),
    );
  }

  if (!amount || amount <= 0) {
    return next(
      new ValidationError(
        "Amount must be positive",
        ERROR_CODES.INVALID_AMOUNT,
        { received: amount },
      ),
    );
  }

  // Process transfer...
  res.json({ success: true });
});

// Example: Not found error
router.get(
  "/transaction/:id",
  (req: Request, res: Response, next: NextFunction) => {
    const transaction = null; // Simulated lookup

    if (!transaction) {
      return next(
        new NotFoundError(
          "Transaction not found",
          ERROR_CODES.TRANSACTION_NOT_FOUND,
          { transactionId: req.params.id },
        ),
      );
    }

    res.json(transaction);
  },
);

// Example: Business logic error
router.post(
  "/withdraw",
  (req: Request, res: Response, next: NextFunction) => {
    const balance = 100;
    const amount = req.body.amount;

    if (amount > balance) {
      return next(
        new BusinessLogicError(
          "Insufficient balance for withdrawal",
          ERROR_CODES.INSUFFICIENT_BALANCE,
          { balance, requested: amount },
        ),
      );
    }

    if (amount > 5000) {
      return next(
        new BusinessLogicError(
          "Daily limit exceeded",
          ERROR_CODES.LIMIT_EXCEEDED,
          { dailyLimit: 5000, requested: amount },
        ),
      );
    }

    res.json({ success: true });
  },
);

export default router;