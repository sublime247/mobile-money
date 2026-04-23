import { redisClient } from "../config/redis";

const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? "5", 10);
const ATTEMPT_WINDOW_SECONDS = parseInt(
  process.env.LOGIN_ATTEMPT_WINDOW_SECONDS ?? "600",
  10,
);
const LOCKOUT_DURATION_SECONDS = parseInt(
  process.env.LOCKOUT_DURATION_SECONDS ?? "600",
  10,
);

const LOCKOUT_KEY_PREFIX = "auth:login:lock:";
const ATTEMPTS_KEY_PREFIX = "auth:login:attempts:";

export interface LockoutStatus {
  isLocked: boolean;
  attemptsRemaining: number;
  minutesRemaining: number | null;
}

export interface LockoutResult {
  isLocked: boolean;
  justLocked: boolean;
  attemptsRemaining: number;
  minutesRemaining: number | null;
  message: string;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function attemptsKey(identifier: string): string {
  return `${ATTEMPTS_KEY_PREFIX}${normalizeIdentifier(identifier)}`;
}

function lockoutKey(identifier: string): string {
  return `${LOCKOUT_KEY_PREFIX}${normalizeIdentifier(identifier)}`;
}

export async function getLockoutStatus(identifier: string): Promise<LockoutStatus> {
  const key = lockoutKey(identifier);
  const ttl = Number(await redisClient.ttl(key));

  if (ttl > 0) {
    return {
      isLocked: true,
      attemptsRemaining: 0,
      minutesRemaining: Math.ceil(ttl / 60),
    };
  }

  const attemptsRaw = await redisClient.get(attemptsKey(identifier));
  const attempts = attemptsRaw ? parseInt(String(attemptsRaw), 10) : 0;

  return {
    isLocked: false,
    attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - attempts),
    minutesRemaining: null,
  };
}

export async function isAccountLocked(identifier: string): Promise<boolean> {
  const status = await getLockoutStatus(identifier);
  return status.isLocked;
}

export async function recordFailedAttempt(
  identifier: string,
): Promise<LockoutResult> {
  const current = await getLockoutStatus(identifier);
  if (current.isLocked) {
    return {
      isLocked: true,
      justLocked: false,
      attemptsRemaining: 0,
      minutesRemaining: current.minutesRemaining,
      message: buildLockedMessage(current.minutesRemaining),
    };
  }

  const attemptKey = attemptsKey(identifier);
  const attempts = Number(await redisClient.incr(attemptKey));

  if (attempts === 1) {
    await redisClient.expire(attemptKey, ATTEMPT_WINDOW_SECONDS);
  }

  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    const lockKey = lockoutKey(identifier);
    await redisClient.set(lockKey, "1", { EX: LOCKOUT_DURATION_SECONDS });

    return {
      isLocked: true,
      justLocked: true,
      attemptsRemaining: 0,
      minutesRemaining: Math.ceil(LOCKOUT_DURATION_SECONDS / 60),
      message: buildLockedMessage(Math.ceil(LOCKOUT_DURATION_SECONDS / 60)),
    };
  }

  const attemptsRemaining = Math.max(0, MAX_LOGIN_ATTEMPTS - attempts);
  return {
    isLocked: false,
    justLocked: false,
    attemptsRemaining,
    minutesRemaining: null,
    message:
      attemptsRemaining === 1
        ? "Invalid credentials. Warning: 1 attempt remaining before your account is locked."
        : `Invalid credentials. ${attemptsRemaining} attempts remaining before lockout.`,
  };
}

export async function recordSuccessfulLogin(identifier: string): Promise<void> {
  await redisClient.del([attemptsKey(identifier), lockoutKey(identifier)]);
}

function buildLockedMessage(minutesRemaining: number | null): string {
  const safeMinutes = minutesRemaining ?? Math.ceil(LOCKOUT_DURATION_SECONDS / 60);
  return `Your account has been temporarily locked due to too many failed login attempts. Please try again in ${safeMinutes} minute${safeMinutes === 1 ? "" : "s"}.`;
}
