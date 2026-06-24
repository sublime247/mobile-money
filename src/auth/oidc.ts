import logger from "../utils/logger";
import axios from "axios";
import passport from "passport";
import { Strategy as GoogleStrategy, Profile as GoogleProfile, VerifyCallback as GoogleVerifyCallback } from "passport-google-oauth20";
import { Strategy as OpenIDConnectStrategy } from "passport-openidconnect";
import { Router, Request, Response } from "express";
import { pool } from "../config/database";
import { ssoConfig } from "../config/sso";
import { generateToken } from "./jwt";
import jwt, { JwtHeader, JwtPayload } from "jsonwebtoken";

interface OIDCProviderMetadata {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
}

interface OIDCValidatedClaims {
  email: string;
  subject: string;
  groups: string[];
  issuer?: string;
  audience?: string;
}

const metadataCache = new Map<string, Promise<OIDCProviderMetadata>>();
const jwksCache = new Map<string, { keys: any[]; expiresAt: number }>();

function normalizeIssuerUrl(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

function oidcConfigurationUrl(issuer: string): string {
  const normalized = normalizeIssuerUrl(issuer);
  return normalized.endsWith("/.well-known/openid-configuration")
    ? normalized
    : `${normalized}/.well-known/openid-configuration`;
}

function formatCertificate(x5c: string): string {
  const chunks = x5c.match(/.{1,64}/g) || [];
  return [`-----BEGIN CERTIFICATE-----`, ...chunks, `-----END CERTIFICATE-----`].join("\n") + "\n";
}

async function fetchOIDCMetadata(issuer: string): Promise<OIDCProviderMetadata> {
  const normalizedIssuer = normalizeIssuerUrl(issuer);
  if (!metadataCache.has(normalizedIssuer)) {
    const metadataPromise = axios
      .get<OIDCProviderMetadata>(oidcConfigurationUrl(normalizedIssuer), {
        timeout: 5000,
      })
      .then((res) => res.data);
    metadataCache.set(normalizedIssuer, metadataPromise);
  }
  return metadataCache.get(normalizedIssuer)!;
}

async function fetchJwks(jwksUri: string): Promise<any[]> {
  const cached = jwksCache.get(jwksUri);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.keys;
  }

  const response = await axios.get<{ keys: any[] }>(jwksUri, { timeout: 5000 });
  const keys = response.data.keys || [];
  jwksCache.set(jwksUri, {
    keys,
    expiresAt: now + 60_000,
  });
  return keys;
}

function getJwtHeader(token: string): JwtHeader {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT format");
  }
  return JSON.parse(Buffer.from(parts[0], "base64").toString("utf8"));
}

function findSigningKey(keys: any[], kid?: string): string {
  let key = keys.find((storedKey) => storedKey.kid === kid);

  if (!key) {
    key = keys[0];
  }

  if (!key) {
    throw new Error("OIDC JWKS has no signing keys");
  }

  if (Array.isArray(key.x5c) && key.x5c.length > 0) {
    return formatCertificate(key.x5c[0]);
  }

  throw new Error("OIDC signing key does not include an x5c certificate");
}

async function verifyIdToken(idToken: string, issuer: string, audience: string): Promise<JwtPayload> {
  const header = getJwtHeader(idToken);
  const metadata = await fetchOIDCMetadata(issuer);
  const keys = await fetchJwks(metadata.jwks_uri);
  const publicKey = findSigningKey(keys, header.kid);

  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ["RS256"],
    audience,
    issuer,
    clockTolerance: 5,
  }) as JwtPayload;

  return payload;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required and must be a string`);
  }
  return value;
}

function extractRawClaims(profile: any): any {
  return profile?._json ?? profile ?? {};
}

export async function validateGoogleOIDCProfile(profile: any, params?: any): Promise<OIDCValidatedClaims> {
  if (!profile || typeof profile !== "object") {
    throw new Error("Invalid Google profile payload");
  }

  const raw = extractRawClaims(profile);
  const email = profile.emails?.[0]?.value || raw.email;
  const subject = profile.id || raw.sub;

  requiredString(subject, "Google subject");
  requiredString(email, "Google email");

  if (raw.email_verified !== true) {
    throw new Error("Google account email must be verified");
  }

  if (raw.iss && raw.iss !== "https://accounts.google.com" && raw.iss !== "accounts.google.com") {
    throw new Error("Google token issuer mismatch");
  }

  const audience = ssoConfig.oidc.google?.clientID;
  if (!audience) {
    throw new Error("Google OIDC client ID is not configured");
  }

  if (params?.id_token && typeof params.id_token === "string") {
    const claims = await verifyIdToken(params.id_token, "https://accounts.google.com", audience);
    if (claims.email_verified !== true) {
      throw new Error("Google ID token email_verified claim is not true");
    }
    if (!claims.sub) {
      throw new Error("Google ID token missing subject claim");
    }
    if (claims.aud !== audience && !(Array.isArray(claims.aud) && claims.aud.includes(audience))) {
      throw new Error("Google ID token audience does not match client ID");
    }
  }

  return {
    email,
    subject,
    issuer: raw.iss || "https://accounts.google.com",
    audience,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
  };
}

export async function validateAzureOIDCProfile(profile: any, params?: any): Promise<OIDCValidatedClaims> {
  if (!profile || typeof profile !== "object") {
    throw new Error("Invalid Azure profile payload");
  }

  const raw = extractRawClaims(profile);
  const email = profile.emails?.[0]?.value || raw.email || raw.preferred_username;
  const subject = profile.id || raw.sub;

  requiredString(subject, "Azure subject");
  requiredString(email, "Azure email");

  const issuer = ssoConfig.oidc.azure?.issuer;
  const audience = ssoConfig.oidc.azure?.clientID;
  if (!issuer || !audience) {
    throw new Error("Azure OIDC issuer and client ID must be configured");
  }

  const normalizedIssuer = normalizeIssuerUrl(issuer);
  if (raw.iss) {
    const actualIssuer = normalizeIssuerUrl(raw.iss);
    if (actualIssuer !== normalizedIssuer && actualIssuer !== `${normalizedIssuer}/v2.0`) {
      throw new Error("Azure token issuer mismatch");
    }
  }

  if (params?.id_token && typeof params.id_token === "string") {
    const claims = await verifyIdToken(params.id_token, issuer, audience);
    if (!claims.sub) {
      throw new Error("Azure ID token missing subject claim");
    }
    if (claims.aud !== audience && !(Array.isArray(claims.aud) && claims.aud.includes(audience))) {
      throw new Error("Azure ID token audience does not match client ID");
    }
  }

  return {
    email,
    subject,
    issuer: raw.iss || issuer,
    audience,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
  };
}

async function processOIDCProfile(
  providerType: "google" | "azure",
  profile: any,
  params?: any,
): Promise<Express.User> {
  const validated =
    providerType === "google"
      ? await validateGoogleOIDCProfile(profile, params)
      : await validateAzureOIDCProfile(profile, params);

  const client = await pool.connect();
  const ssoSubject = validated.subject;
  const email = validated.email;
  const providerId = `oidc-${providerType}`;

  try {
    await client.query("BEGIN");

    const ssoUserResult = await client.query(
      "SELECT * FROM sso_users WHERE provider_id = $1 AND sso_subject = $2",
      [providerId, ssoSubject],
    );

    let ssoUser;
    let userId: string;

    if (ssoUserResult.rows.length > 0) {
      ssoUser = ssoUserResult.rows[0];
      userId = ssoUser.user_id;

      await client.query(
        `UPDATE sso_users
         SET sso_email = $1, last_login_at = CURRENT_TIMESTAMP, is_active = true
         WHERE id = $2`,
        [email, ssoUser.id],
      );

      console.log(`[OIDC] Updated existing SSO user: ${userId}`);
    } else {
      const phoneNumber = `sso-${ssoSubject}`;

      const userResult = await client.query(
        `INSERT INTO users (phone_number, kyc_level, sso_only)
         VALUES ($1, 'unverified', true)
         RETURNING id`,
        [phoneNumber],
      );

      userId = userResult.rows[0].id;

      const ssoUserInsertResult = await client.query(
        `INSERT INTO sso_users (user_id, provider_id, sso_subject, sso_email, last_login_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         RETURNING *`,
        [userId, providerId, ssoSubject, email],
      );

      ssoUser = ssoUserInsertResult.rows[0];
      console.log(`[OIDC] Created new SSO user: ${userId}`);
    }

    await client.query(
      `INSERT INTO sso_audit_log (provider_id, user_id, event_type, event_data)
       VALUES ($1, $2, 'login', $3)`,
      [
        providerId,
        userId,
        JSON.stringify({
          sso_subject: ssoSubject,
          sso_email: email,
          sso_groups: validated.groups,
        }),
      ],
    );

    await client.query("COMMIT");

    return {
      id: userId,
      ssoUserId: ssoUser.id,
      providerId,
      ssoSubject,
      email,
      groups: validated.groups,
    } as Express.User;
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[OIDC] Error processing profile:", error);
    throw error;
  } finally {
    client.release();
  }
}

function normalizeGoogleVerifyCallbackArgs(args: IArguments) {
  const list = Array.from(args) as any[];
  const done = list[list.length - 1];
  const profile = list.find((item) => item && typeof item === "object" && item.provider === "google");
  const params = list.find((item) => item && typeof item === "object" && item.id_token);
  return { profile, params, done };
}

function normalizeAzureVerifyCallbackArgs(args: IArguments) {
  const list = Array.from(args) as any[];
  const done = list[list.length - 1];
  const profile = list.find((item) => item && typeof item === "object" && item.id);
  const params = list.find((item) => item && typeof item === "object" && item.id_token);
  return { profile, params, done };
}

export function initializeOIDCProviders() {
  const googleConfig = ssoConfig.oidc.google;
  if (googleConfig && googleConfig.clientID && googleConfig.clientSecret && googleConfig.callbackURL) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: googleConfig.clientID,
          clientSecret: googleConfig.clientSecret,
          callbackURL: googleConfig.callbackURL,
          scope: ["profile", "email"],
        },
        async function (this: any, accessToken: string, refreshToken: string, paramsOrProfile: any, profileOrDone: any, maybeDone?: any) {
          const { profile, params, done } = normalizeGoogleVerifyCallbackArgs(arguments);
          try {
            const user = await processOIDCProfile("google", profile, params);
            return done(null, user);
          } catch (error) {
            return done(error as Error);
          }
        } as any,
      ),
    );
    console.log("[OIDC] Google OAuth2 strategy initialized");
  }

  const azureConfig = ssoConfig.oidc.azure;
  if (azureConfig && azureConfig.clientID && azureConfig.clientSecret && azureConfig.issuer && azureConfig.callbackURL) {
    passport.use(
      "azure-oidc",
      new OpenIDConnectStrategy(
        {
          issuer: azureConfig.issuer,
          authorizationURL: `${normalizeIssuerUrl(azureConfig.issuer)}/oauth2/v2.0/authorize`,
          tokenURL: `${normalizeIssuerUrl(azureConfig.issuer)}/oauth2/v2.0/token`,
          userInfoURL: `${normalizeIssuerUrl(azureConfig.issuer)}/openid/userinfo`,
          clientID: azureConfig.clientID,
          clientSecret: azureConfig.clientSecret,
          callbackURL: azureConfig.callbackURL,
          scope: ["openid", "profile", "email"],
        },
        async function (this: any, ...args: any[]) {
          const { profile, params, done } = normalizeAzureVerifyCallbackArgs(arguments);
          try {
            const user = await processOIDCProfile("azure", profile, params);
            return done(null, user);
          } catch (error) {
            return done(error as Error);
          }
        } as any,
      ),
    );
    console.log("[OIDC] Azure AD OIDC strategy initialized");
  }
}

export function createOIDCRouter() {
  const router = Router();

  const handleSuccess = (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user) {
      return res.status(401).json({ error: "Authentication failed" });
    }
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: "user",
    });

    return res.json({ token, user });
  };

  if (ssoConfig.oidc.google?.clientID) {
    router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));
    router.get("/google/callback", passport.authenticate("google", { session: false }), handleSuccess);
  }

  if (ssoConfig.oidc.azure?.clientID) {
    router.get("/azure", passport.authenticate("azure-oidc", { session: false }));
    router.get("/azure/callback", passport.authenticate("azure-oidc", { session: false }), handleSuccess);
  }

  return router;
}
