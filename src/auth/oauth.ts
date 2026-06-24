import crypto from "crypto";
import { Request, Response, Router } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { redisClient } from "../config/redis";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  defaultScope: string;
}

interface AuthorizationCodeRecord {
  subject: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  subject: string;
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface TokenResponsePayload {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface OAuthAccessTokenClaims extends JwtPayload {
  sub: string;
  client_id: string;
  scope: string;
  token_use: "access";
  role: "oauth-client";
}

interface OAuthTokenStore {
  saveAuthorizationCode(
    code: string,
    record: AuthorizationCodeRecord,
    ttlSeconds: number,
  ): Promise<void>;
  consumeAuthorizationCode(
    code: string,
  ): Promise<AuthorizationCodeRecord | null>;
  saveRefreshToken(
    refreshToken: string,
    record: RefreshTokenRecord,
    ttlSeconds: number,
  ): Promise<void>;
  getRefreshToken(refreshToken: string): Promise<RefreshTokenRecord | null>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

class InMemoryOAuthTokenStore implements OAuthTokenStore {
  private authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();

  async saveAuthorizationCode(
    code: string,
    record: AuthorizationCodeRecord,
    _ttlSeconds: number,
  ): Promise<void> {
    this.authorizationCodes.set(hashOpaqueToken(code), record);
  }

  async consumeAuthorizationCode(
    code: string,
  ): Promise<AuthorizationCodeRecord | null> {
    const key = hashOpaqueToken(code);
    const record = this.authorizationCodes.get(key) ?? null;
    this.authorizationCodes.delete(key);

    if (!record || record.expiresAt <= Date.now()) {
      return null;
    }

    return record;
  }

  async saveRefreshToken(
    refreshToken: string,
    record: RefreshTokenRecord,
    _ttlSeconds: number,
  ): Promise<void> {
    this.refreshTokens.set(hashOpaqueToken(refreshToken), record);
  }

  async getRefreshToken(
    refreshToken: string,
  ): Promise<RefreshTokenRecord | null> {
    const record =
      this.refreshTokens.get(hashOpaqueToken(refreshToken)) ?? null;
    if (!record || record.expiresAt <= Date.now()) {
      return null;
    }

    return record;
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    this.refreshTokens.delete(hashOpaqueToken(refreshToken));
  }
}

function getOAuthConfig(): OAuthClientConfig {
  return {
    clientId: process.env.OAUTH_CLIENT_ID || "mobile-money-client",
    clientSecret: process.env.OAUTH_CLIENT_SECRET || "change-me-in-production",
    redirectUri:
      process.env.OAUTH_REDIRECT_URI || "http://localhost:3000/oauth/callback",
    issuer: process.env.OAUTH_ISSUER || "mobile-money-api",
    audience: process.env.OAUTH_AUDIENCE || "mobile-money-api",
    accessTokenTtlSeconds: parsePositiveInt(
      process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      3600,
    ),
    refreshTokenTtlSeconds: parsePositiveInt(
      process.env.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      30 * 24 * 60 * 60,
    ),
    authorizationCodeTtlSeconds: parsePositiveInt(
      process.env.OAUTH_AUTH_CODE_TTL_SECONDS,
      300,
    ),
    defaultScope:
      process.env.OAUTH_DEFAULT_SCOPE || "transactions:read reports:read",
  };
}

function getJwtSecret(): string {
  return (
    process.env.OAUTH_JWT_SECRET ||
    process.env.JWT_SECRET ||
    "oauth-dev-secret-change-me"
  );
}

function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createOpaqueToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function createAccessToken(
  subject: string,
  clientId: string,
  scope: string,
  config: OAuthClientConfig,
): string {
  return jwt.sign(
    {
      client_id: clientId,
      scope,
      token_use: "access",
      role: "oauth-client",
    },
    getJwtSecret(),
    {
      algorithm: "HS256",
      subject,
      audience: config.audience,
      issuer: config.issuer,
      expiresIn: config.accessTokenTtlSeconds,
      jwtid: crypto.randomUUID(),
    },
  );
}

function buildTokenResponse(
  subject: string,
  clientId: string,
  scope: string,
  config: OAuthClientConfig,
): TokenResponsePayload {
  return {
    access_token: createAccessToken(subject, clientId, scope, config),
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSeconds,
    refresh_token: createOpaqueToken(),
    scope,
  };
}

function createRedisBackedStore(
  fallbackStore: OAuthTokenStore = new InMemoryOAuthTokenStore(),
): OAuthTokenStore {
  return {
    async saveAuthorizationCode(
      code: string,
      record: AuthorizationCodeRecord,
      ttlSeconds: number,
    ): Promise<void> {
      if (redisClient.isOpen) {
        await redisClient.set(
          redisKey("auth-code", code),
          JSON.stringify(record),
          { EX: ttlSeconds },
        );
        return;
      }
      return fallbackStore.saveAuthorizationCode(code, record, ttlSeconds);
    },

    async consumeAuthorizationCode(
      code: string,
    ): Promise<AuthorizationCodeRecord | null> {
      if (redisClient.isOpen) {
        const key = redisKey("auth-code", code);
        const raw = await redisClient.get(key);
        if (!raw) {
          return null;
        }
        await redisClient.del(key);
        const rawStr = typeof raw === "string" ? raw : raw.toString();
        const record = JSON.parse(rawStr) as AuthorizationCodeRecord;
        return record.expiresAt > Date.now() ? record : null;
      }
      return fallbackStore.consumeAuthorizationCode(code);
    },

    async saveRefreshToken(
      refreshToken: string,
      record: RefreshTokenRecord,
      ttlSeconds: number,
    ): Promise<void> {
      if (redisClient.isOpen) {
        await redisClient.set(
          redisKey("refresh-token", refreshToken),
          JSON.stringify(record),
          { EX: ttlSeconds },
        );
        return;
      }
      return fallbackStore.saveRefreshToken(refreshToken, record, ttlSeconds);
    },

    async getRefreshToken(
      refreshToken: string,
    ): Promise<RefreshTokenRecord | null> {
      if (redisClient.isOpen) {
        const raw = await redisClient.get(
          redisKey("refresh-token", refreshToken),
        );
        if (!raw) {
          return null;
        }
        const rawStr = typeof raw === "string" ? raw : raw.toString();
        const record = JSON.parse(rawStr) as RefreshTokenRecord;
        return record.expiresAt > Date.now() ? record : null;
      }
      return fallbackStore.getRefreshToken(refreshToken);
    },

    async revokeRefreshToken(refreshToken: string): Promise<void> {
      if (redisClient.isOpen) {
        await redisClient.del(redisKey("refresh-token", refreshToken));
        return;
      }
      return fallbackStore.revokeRefreshToken(refreshToken);
    },
  };
}

function redisKey(prefix: string, rawToken: string): string {
  return `oauth:${prefix}:${hashOpaqueToken(rawToken)}`;
}

function buildRedirectUri(
  redirectUri: string,
  code: string,
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

function sendOAuthError(
  res: Response,
  status: number,
  error: string,
  errorDescription: string,
): Response {
  return res.status(status).json({
    error,
    error_description: errorDescription,
  });
}

function validateClient(
  clientId: string | undefined,
  redirectUri: string | undefined,
  config: OAuthClientConfig,
): string | null {
  if (!clientId || clientId !== config.clientId) {
    return "Unknown client_id";
  }

  if (!redirectUri || redirectUri !== config.redirectUri) {
    return "Invalid redirect_uri";
  }

  return null;
}

function parseBasicClientCredentials(req: Request): {
  clientId?: string;
  clientSecret?: string;
} {
  const authorization = req.header("Authorization");
  if (!authorization?.startsWith("Basic ")) {
    return {};
  }

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    const [clientId, clientSecret] = decoded.split(":", 2);
    return { clientId, clientSecret };
  } catch {
    return {};
  }
}

function requireAuthorizationAdminKey(req: Request): boolean {
  const adminKey = process.env.ADMIN_API_KEY || "dev-admin-key";
  const provided = req.header("X-API-Key");
  return Boolean(provided && provided === adminKey);
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  clientId: string,
  store: OAuthTokenStore,
  config: OAuthClientConfig,
): Promise<TokenResponsePayload | null> {
  const record = await store.consumeAuthorizationCode(code);
  if (
    !record ||
    record.clientId !== clientId ||
    record.redirectUri !== redirectUri
  ) {
    return null;
  }

  const response = buildTokenResponse(
    record.subject,
    record.clientId,
    record.scope,
    config,
  );

  await store.saveRefreshToken(
    response.refresh_token,
    {
      subject: record.subject,
      clientId: record.clientId,
      scope: record.scope,
      expiresAt: Date.now() + config.refreshTokenTtlSeconds * 1000,
    },
    config.refreshTokenTtlSeconds,
  );

  return response;
}

async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  store: OAuthTokenStore,
  config: OAuthClientConfig,
): Promise<TokenResponsePayload | null> {
  const record = await store.getRefreshToken(refreshToken);
  if (!record || record.clientId !== clientId) {
    return null;
  }

  await store.revokeRefreshToken(refreshToken);

  const response = buildTokenResponse(
    record.subject,
    record.clientId,
    record.scope,
    config,
  );

  await store.saveRefreshToken(
    response.refresh_token,
    {
      subject: record.subject,
      clientId: record.clientId,
      scope: record.scope,
      expiresAt: Date.now() + config.refreshTokenTtlSeconds * 1000,
    },
    config.refreshTokenTtlSeconds,
  );

  return response;
}

export function verifyOAuthAccessToken(token: string): OAuthAccessTokenClaims {
  return jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
    issuer: getOAuthConfig().issuer,
    audience: getOAuthConfig().audience,
  }) as OAuthAccessTokenClaims;
}

export function createOAuthTokenStore(): OAuthTokenStore {
  return createRedisBackedStore();
}

export function createOAuthRouter(
  store: OAuthTokenStore = createOAuthTokenStore(),
): Router {
  const router = Router();

  router.get("/authorize", async (req: Request, res: Response) => {
    if (!requireAuthorizationAdminKey(req)) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
        error: "Unauthorized",
        message:
          "Valid administrative API key required in X-API-Key header to authorize OAuth clients",
      });
    }

    const config = getOAuthConfig();
    const responseType = String(req.query.response_type || "");
    const clientId = String(req.query.client_id || "");
    const redirectUri = String(req.query.redirect_uri || "");
    const state = req.query.state ? String(req.query.state) : undefined;
    const subject = String(req.query.subject || "");
    const requestedScope = req.query.scope
      ? String(req.query.scope)
      : config.defaultScope;

    if (responseType !== "code") {
      return sendOAuthError(
        res,
        400,
        "unsupported_response_type",
        "Only response_type=code is supported",
      );
    }

    const clientError = validateClient(clientId, redirectUri, config);
    if (clientError) {
      return sendOAuthError(res, 400, "invalid_client", clientError);
    }

    if (!subject.trim()) {
      return sendOAuthError(
        res,
        400,
        "invalid_request",
        "subject is required to issue an authorization code",
      );
    }

    const code = createOpaqueToken();
    await store.saveAuthorizationCode(
      code,
      {
        subject: subject.trim(),
        clientId,
        redirectUri,
        scope: requestedScope.trim() || config.defaultScope,
        expiresAt: Date.now() + config.authorizationCodeTtlSeconds * 1000,
      },
      config.authorizationCodeTtlSeconds,
    );

    return res.redirect(buildRedirectUri(redirectUri, code, state));
  });

  router.post("/token", async (req: Request, res: Response) => {
    const config = getOAuthConfig();
    const basicCredentials = parseBasicClientCredentials(req);
    const clientId = String(
      basicCredentials.clientId || req.body.client_id || "",
    );
    const clientSecret = String(
      basicCredentials.clientSecret || req.body.client_secret || "",
    );

    if (clientId !== config.clientId || clientSecret !== config.clientSecret) {
      return sendOAuthError(
        res,
        401,
        "invalid_client",
        "Client authentication failed",
      );
    }

    const grantType = String(req.body.grant_type || "");

    if (grantType === "authorization_code") {
      const code = String(req.body.code || "");
      const redirectUri = String(req.body.redirect_uri || "");

      if (!code || !redirectUri) {
        return sendOAuthError(
          res,
          400,
          "invalid_request",
          "code and redirect_uri are required for authorization_code grant",
        );
      }

      const response = await exchangeAuthorizationCode(
        code,
        redirectUri,
        clientId,
        store,
        config,
      );

      if (!response) {
        return sendOAuthError(
          res,
          400,
          "invalid_grant",
          "Authorization code is invalid, expired, or already used",
        );
      }

      return res.json(response);
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(req.body.refresh_token || "");
      if (!refreshToken) {
        return sendOAuthError(
          res,
          400,
          "invalid_request",
          "refresh_token is required for refresh_token grant",
        );
      }

      const response = await exchangeRefreshToken(
        refreshToken,
        clientId,
        store,
        config,
      );

      if (!response) {
        return sendOAuthError(
          res,
          400,
          "invalid_grant",
          "Refresh token is invalid or expired",
        );
      }

      return res.json(response);
    }

    return sendOAuthError(
      res,
      400,
      "unsupported_grant_type",
      "Supported grant types are authorization_code and refresh_token",
    );
  });

  return router;
}
