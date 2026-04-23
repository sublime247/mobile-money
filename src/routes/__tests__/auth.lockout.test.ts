import express from "express";
import request from "supertest";

jest.mock("../../auth/jwt", () => ({
  generateToken: jest.fn(() => "jwt-token"),
  verifyToken: jest.fn(),
  generateRefreshToken: jest.fn(async () => "refresh-token"),
  verifyRefreshToken: jest.fn(),
}));

jest.mock("../../middleware/auth", () => ({
  authenticateToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock("../../controllers/tokenController", () => ({
  tokenController: {
    findAll: jest.fn(),
    revokeAll: jest.fn(),
    revoke: jest.fn(),
  },
}));

jest.mock("../../services/userService", () => ({
  authenticateUser: jest.fn(),
  getUserByPhoneNumber: jest.fn(),
  getUserPermissions: jest.fn(async () => ["read:wallet"]),
}));

jest.mock("../../auth/lockout", () => ({
  getLockoutStatus: jest.fn(),
  recordFailedAttempt: jest.fn(),
  recordSuccessfulLogin: jest.fn(),
}));

const sendAccountLockoutNotice = jest.fn();
jest.mock("../../services/email", () => ({
  EmailService: jest.fn().mockImplementation(() => ({
    sendAccountLockoutNotice,
  })),
}));

import { authRoutes } from "../auth";
import {
  authenticateUser,
  getUserByPhoneNumber,
  getUserPermissions,
} from "../../services/userService";
import {
  getLockoutStatus,
  recordFailedAttempt,
  recordSuccessfulLogin,
} from "../../auth/lockout";

const mockedAuthenticateUser = authenticateUser as jest.Mock;
const mockedGetUserByPhoneNumber = getUserByPhoneNumber as jest.Mock;
const mockedGetUserPermissions = getUserPermissions as jest.Mock;
const mockedGetLockoutStatus = getLockoutStatus as jest.Mock;
const mockedRecordFailedAttempt = recordFailedAttempt as jest.Mock;
const mockedRecordSuccessfulLogin = recordSuccessfulLogin as jest.Mock;

describe("auth lockout route", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRoutes);

    mockedGetUserPermissions.mockResolvedValue(["read:wallet"]);
  });

  it("blocks login when account is already locked", async () => {
    mockedGetLockoutStatus.mockResolvedValue({
      isLocked: true,
      attemptsRemaining: 0,
      minutesRemaining: 8,
    });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "+15551234567" });

    expect(response.status).toBe(423);
    expect(response.body.error).toBe("Account locked");
    expect(mockedAuthenticateUser).not.toHaveBeenCalled();
  });

  it("records failed attempt and returns unauthorized", async () => {
    mockedGetLockoutStatus.mockResolvedValue({
      isLocked: false,
      attemptsRemaining: 5,
      minutesRemaining: null,
    });
    mockedAuthenticateUser.mockResolvedValue(null);
    mockedRecordFailedAttempt.mockResolvedValue({
      isLocked: false,
      justLocked: false,
      attemptsRemaining: 4,
      minutesRemaining: null,
      message: "Invalid credentials. 4 attempts remaining before lockout.",
    });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "+15550000000" });

    expect(response.status).toBe(401);
    expect(response.body.message).toContain("4 attempts remaining");
    expect(sendAccountLockoutNotice).not.toHaveBeenCalled();
  });

  it("sends lockout email when threshold is reached", async () => {
    mockedGetLockoutStatus.mockResolvedValue({
      isLocked: false,
      attemptsRemaining: 1,
      minutesRemaining: null,
    });
    mockedAuthenticateUser.mockResolvedValue(null);
    mockedRecordFailedAttempt.mockResolvedValue({
      isLocked: true,
      justLocked: true,
      attemptsRemaining: 0,
      minutesRemaining: 10,
      message: "Your account has been temporarily locked.",
    });
    mockedGetUserByPhoneNumber.mockResolvedValue({ email: "user@example.com" });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "+15551112222" });

    expect(response.status).toBe(423);
    expect(sendAccountLockoutNotice).toHaveBeenCalledWith("user@example.com", 10);
  });

  it("resets lockout counters after successful login", async () => {
    mockedGetLockoutStatus.mockResolvedValue({
      isLocked: false,
      attemptsRemaining: 5,
      minutesRemaining: null,
    });
    mockedAuthenticateUser.mockResolvedValue({
      id: "user-1",
      phone_number: "+15551231234",
      role_name: "user",
    });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ phone_number: "+15551231234" });

    expect(response.status).toBe(200);
    expect(response.body.token).toBe("jwt-token");
    expect(mockedRecordSuccessfulLogin).toHaveBeenCalledWith("+15551231234");
  });
});
