import passport from "passport";
import {
  Strategy as GoogleStrategy,
  Profile as GoogleProfile,
  VerifyCallback as GoogleVerifyCallback,
} from "passport-google-oauth20";
import { Strategy as OpenIDConnectStrategy } from "passport-openidconnect";
import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { ssoConfig } from "../config/sso";
import { generateToken } from "./jwt";

// Map OIDC profile to local user mimicking SAML implementation
async function processOIDCProfile(
  providerType: "google" | "azure",
  profile: any,
): Promise<Express.User> {
  const client = await pool.connect();
  const ssoSubject = profile.id || profile.sub;
  const email =
    profile.emails?.[0]?.value || `${ssoSubject}@${providerType}.sso`;
  // Provide a generic provider ID for OIDC if not defined in DB, normally this links to sso_providers
  // We'll use a string like "oidc-google" or "oidc-azure"
  const providerId = `oidc-${providerType}`;

  try {
    await client.query("BEGIN");

    // Ensure the OIDC provider exists in sso_providers or we just rely on string matching
    // Attempting to use existing sso_providers table or bypassing it. The task says "reusing the existing sso_users table pattern"

    // Check if SSO user exists
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
    };
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[OIDC] Error processing profile:", error);
    throw error;
  } finally {
    client.release();
  }
}

export function initializeOIDCProviders() {
  const googleConfig = ssoConfig.oidc.google;
  if (googleConfig && googleConfig.clientID && googleConfig.clientSecret) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: googleConfig.clientID,
          clientSecret: googleConfig.clientSecret,
          callbackURL: googleConfig.callbackURL,
        },
        async (
          accessToken: string,
          refreshToken: string,
          profile: GoogleProfile,
          done: GoogleVerifyCallback,
        ) => {
          try {
            const user = await processOIDCProfile("google", profile);
            return done(null, user);
          } catch (error) {
            return done(error as Error);
          }
        },
      ),
    );
    console.log("[OIDC] Google OAuth2 strategy initialized");
  }

  const azureConfig = ssoConfig.oidc.azure;
  if (
    azureConfig &&
    azureConfig.clientID &&
    azureConfig.clientSecret &&
    azureConfig.issuer
  ) {
    passport.use(
      "azure-oidc",
      new OpenIDConnectStrategy(
        {
          issuer: azureConfig.issuer,
          authorizationURL: `${azureConfig.issuer}/oauth2/v2.0/authorize`,
          tokenURL: `${azureConfig.issuer}/oauth2/v2.0/token`,
          userInfoURL: `${azureConfig.issuer}/openid/userinfo`,
          clientID: azureConfig.clientID,
          clientSecret: azureConfig.clientSecret,
          callbackURL: azureConfig.callbackURL,
          scope: ["openid", "profile", "email"],
        },
        async (issuer: string, profile: any, done: any) => {
          try {
            const user = await processOIDCProfile("azure", profile);
            return done(null, user);
          } catch (error) {
            return done(error as Error);
          }
        },
      ),
    );
    console.log("[OIDC] Azure AD OIDC strategy initialized");
  }
}

export function createOIDCRouter() {
  const router = Router();

  // Redirect to JWT generation pattern like SAML
  const handleSuccess = (req: Request, res: Response) => {
    const user = req.user as any;
    if (!user) {
      return res.status(401).json({ error: "Authentication failed" });
    }
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: "user", // Default OIDC role
    });

    // In a real app we'd redirect to a frontend with token or issue a secure cookie,
    // but returning JSON for API
    return res.json({ token, user });
  };

  if (ssoConfig.oidc.google?.clientID) {
    router.get(
      "/google",
      passport.authenticate("google", {
        scope: ["profile", "email"],
        session: false,
      }),
    );
    router.get(
      "/google/callback",
      passport.authenticate("google", { session: false }),
      handleSuccess,
    );
  }

  if (ssoConfig.oidc.azure?.clientID) {
    router.get(
      "/azure",
      passport.authenticate("azure-oidc", { session: false }),
    );
    router.get(
      "/azure/callback",
      passport.authenticate("azure-oidc", { session: false }),
      handleSuccess,
    );
  }

  return router;
}
