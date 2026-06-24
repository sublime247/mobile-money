import rateLimit from "express-rate-limit";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const AUTH_RATE_LIMITS = {
  login: {
    windowMs: FIFTEEN_MINUTES_MS,
    limit: 5,
    message:
      "Too many login attempts from this IP, please try again after 15 minutes",
  },
  register: {
    windowMs: ONE_HOUR_MS,
    limit: 3,
    message:
      "Too many registration attempts from this IP, please try again after 1 hour",
  },
};

type AuthRateLimiterConfig = {
  windowMs: number;
  limit: number;
  message: string;
};

const skipRateLimitInTests = () =>
  process.env.NODE_ENV === "test" &&
  process.env.ENABLE_AUTH_RATE_LIMIT_TESTS !== "true";

export const createAuthRateLimiter = (config: AuthRateLimiterConfig) =>
  rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipRateLimitInTests,
    message: {
      error: "Too Many Requests",
      message: config.message,
    },
  });

export const loginRateLimiter = createAuthRateLimiter(AUTH_RATE_LIMITS.login);
export const registerRateLimiter = createAuthRateLimiter(
  AUTH_RATE_LIMITS.register,
);
export const authRateLimiter = loginRateLimiter;
