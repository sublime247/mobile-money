import rateLimit from "express-rate-limit";

/**
 * Rate limiter for authentication routes (Login/Register)
 * Limit: 5 attempts per 15 minutes per IP
 */
export const authRateLimiter =
  process.env.NODE_ENV === "test"
    ? (req: any, res: any, next: any) => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5, // 5 attempts
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: "Too Many Requests",
          message:
            "Too many authentication attempts from this IP, please try again after 15 minutes",
        },
      });
