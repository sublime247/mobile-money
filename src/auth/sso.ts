import passport from "passport";
import {
  Strategy as SamlStrategy,
  VerifiedCallback,
  Profile as SamlProfile,
} from "@node-saml/passport-saml";
import { Request, Response, NextFunction, Router } from "express";
import { pool } from "../config/database";
import { generateToken, generateRefreshToken } from "./jwt";
import { redisClient } from "../config/redis";

// SSO Configuration Interface
export interface SSOConfig {
  entryPoint: string;
  issuer: string;
  cert: string;
  callbackUrl: string;
  providerType: "okta" | "entra" | "saml";
  providerName: string;
}

// SSO User Profile from IdP
export interface SSOUserProfile {
  nameID: string;
  nameIDFormat?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  groups?: string[];
  sessionIndex?: string;
  [key: string]: unknown;
}

// SSO User from database
export interface SSOUser {
  id: string;
  user_id: string;
  provider_id: string;
  sso_subject: string;
  sso_email: string | null;
  sso_groups: string[];
  is_active: boolean;
  last_login_at: Date | null;
}

// Group to Role Mapping
export interface GroupRoleMapping {
  sso_group_name: string;
  role_name: string;
  role_id: string;
}

// SSO Provider from database
export interface SSOProvider {
  id: string;
  name: string;
  provider_type: string;
  entry_point: string;
  issuer: string;
  cert: string;
  callback_url: string;
  is_active: boolean;
}

/**
 * SSO Service Class
 * Handles all SSO-related operations including SAML strategy, group mapping, and user management
 */
export class SSOService {
  private static instance: SSOService;
  private samlStrategy: SamlStrategy | null = null;
  private initialized: boolean = false;

  private constructor() {}

  /**
   * Get singleton instance of SSOService
   */
  public static getInstance(): SSOService {
    if (!SSOService.instance) {
      SSOService.instance = new SSOService();
    }
    return SSOService.instance;
  }

  /**
   * Initialize Passport with SAML strategy
   */
  public async initializePassport(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize passport
    passport.initialize();

    // Serialize user for session
    passport.serializeUser((user: Express.User, done) => {
      done(null, user);
    });

    // Deserialize user from session
    passport.deserializeUser((user: Express.User, done) => {
      done(null, user);
    });

    // Load active SSO providers and configure strategies
    await this.loadAndConfigureStrategies();

    this.initialized = true;
    console.log("[SSO] Passport initialized with SAML strategies");
  }

  /**
   * Load active SSO providers from database and configure SAML strategies
   */
  private async loadAndConfigureStrategies(): Promise<void> {
    try {
      const result = await pool.query(
        "SELECT * FROM sso_providers WHERE is_active = true",
      );

      for (const provider of result.rows) {
        this.configureSAMLStrategy(provider);
      }

      console.log(`[SSO] Configured ${result.rows.length} SAML strategy(ies)`);
    } catch (error) {
      console.error("[SSO] Error loading SSO providers:", error);
      throw error;
    }
  }

  /**
   * Configure SAML strategy for a specific provider
   */
  private configureSAMLStrategy(provider: SSOProvider): void {
    const samlConfig = {
      entryPoint: provider.entry_point,
      issuer: provider.issuer,
      cert: provider.cert,
      callbackUrl: provider.callback_url,
      wantAuthnResponseSigned: true,
      wantAssertionsSigned: true,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "sha256",
      identifierFormat:
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    };

    const verifySamlProfile = async (
      profile: SamlProfile | null | undefined,
      done: VerifiedCallback,
    ) => {
      try {
        if (!profile?.nameID) {
          return done(new Error("SAML profile is missing nameID"));
        }

        // Process SSO profile and create/update user
        const user = await this.processSSOProfile(
          profile as SSOUserProfile,
          provider.id,
        );
        return done(null, user);
      } catch (error) {
        return done(error as Error);
      }
    };

    const strategy = new SamlStrategy(
      samlConfig as any,
      verifySamlProfile as any,
      verifySamlProfile as any,
    );

    passport.use(
      `saml-${provider.id}`,
      strategy as unknown as passport.Strategy,
    );
    console.log(
      `[SSO] Configured SAML strategy for provider: ${provider.name}`,
    );
  }

  /**
   * Process SSO profile from IdP and create/update user
   */
  private async processSSOProfile(
    profile: SSOUserProfile,
    providerId: string,
  ): Promise<Record<string, unknown>> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Check if SSO user exists
      const ssoUserResult = await client.query(
        "SELECT * FROM sso_users WHERE provider_id = $1 AND sso_subject = $2",
        [providerId, profile.nameID],
      );

      let ssoUser: SSOUser;
      let userId: string;

      if (ssoUserResult.rows.length > 0) {
        // Existing SSO user - update and sync
        ssoUser = ssoUserResult.rows[0];
        userId = ssoUser.user_id;

        // Update SSO user data
        await client.query(
          `UPDATE sso_users 
           SET sso_email = $1, sso_groups = $2, last_login_at = CURRENT_TIMESTAMP, is_active = true
           WHERE id = $3`,
          [profile.email || null, profile.groups || [], ssoUser.id],
        );

        // Sync groups to roles
        await this.syncGroupsToRoles(
          client,
          userId,
          profile.groups || [],
          providerId,
        );

        console.log(`[SSO] Updated existing SSO user: ${userId}`);
      } else {
        // New SSO user - create user and SSO record
        const phoneNumber = `sso-${profile.nameID}`; // Generate unique phone for SSO users

        // Create user
        const userResult = await client.query(
          `INSERT INTO users (phone_number, kyc_level, sso_only, sso_provider_id)
           VALUES ($1, 'unverified', true, $2)
           RETURNING id`,
          [phoneNumber, providerId],
        );

        userId = userResult.rows[0].id;

        // Create SSO user record
        const ssoUserInsertResult = await client.query(
          `INSERT INTO sso_users (user_id, provider_id, sso_subject, sso_email, sso_groups, last_login_at)
           VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
           RETURNING *`,
          [
            userId,
            providerId,
            profile.nameID,
            profile.email || null,
            profile.groups || [],
          ],
        );

        ssoUser = ssoUserInsertResult.rows[0];

        // Assign role based on groups
        await this.syncGroupsToRoles(
          client,
          userId,
          profile.groups || [],
          providerId,
        );

        console.log(`[SSO] Created new SSO user: ${userId}`);
      }

      // Log SSO login event
      await client.query(
        `INSERT INTO sso_audit_log (provider_id, user_id, event_type, event_data)
         VALUES ($1, $2, 'login', $3)`,
        [
          providerId,
          userId,
          JSON.stringify({
            sso_subject: profile.nameID,
            sso_email: profile.email,
            sso_groups: profile.groups,
          }),
        ],
      );

      await client.query("COMMIT");

      // Return user object for Passport
      return {
        id: userId,
        ssoUserId: ssoUser.id,
        providerId,
        ssoSubject: profile.nameID,
        email: profile.email,
        groups: profile.groups || [],
      };
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[SSO] Error processing SSO profile:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Sync SSO groups to RBAC roles
   */
  private async syncGroupsToRoles(
    client: any,
    userId: string,
    groups: string[],
    providerId: string,
  ): Promise<void> {
    if (groups.length === 0) {
      console.log(`[SSO] No groups to sync for user: ${userId}`);
      return;
    }

    // Get group-to-role mappings for this provider
    const mappingsResult = await client.query(
      `SELECT sgrm.sso_group_name, r.name as role_name, r.id as role_id
       FROM sso_group_role_mappings sgrm
       JOIN roles r ON sgrm.role_id = r.id
       WHERE sgrm.provider_id = $1`,
      [providerId],
    );

    const mappings: GroupRoleMapping[] = mappingsResult.rows;

    // Find the highest priority role from user's groups
    let assignedRole: string | null = null;
    let assignedRoleId: string | null = null;

    // Priority order: admin > user > viewer
    const rolePriority = ["admin", "user", "viewer"];

    for (const priority of rolePriority) {
      for (const mapping of mappings) {
        if (
          groups.includes(mapping.sso_group_name) &&
          mapping.role_name === priority
        ) {
          assignedRole = mapping.role_name;
          assignedRoleId = mapping.role_id;
          break;
        }
      }
      if (assignedRole) break;
    }

    // If no mapping found, assign default 'user' role
    if (!assignedRole) {
      const defaultRoleResult = await client.query(
        "SELECT id, name FROM roles WHERE name = 'user' LIMIT 1",
      );
      if (defaultRoleResult.rows.length > 0) {
        assignedRole = defaultRoleResult.rows[0].name;
        assignedRoleId = defaultRoleResult.rows[0].id;
      }
    }

    // Update user's role
    if (assignedRoleId) {
      await client.query("UPDATE users SET role_id = $1 WHERE id = $2", [
        assignedRoleId,
        userId,
      ]);

      // Log role update event
      await client.query(
        `INSERT INTO sso_audit_log (provider_id, user_id, event_type, event_data)
         VALUES ($1, $2, 'role_update', $3)`,
        [
          providerId,
          userId,
          JSON.stringify({
            sso_groups: groups,
            assigned_role: assignedRole,
            assigned_role_id: assignedRoleId,
          }),
        ],
      );

      console.log(
        `[SSO] Synced groups to role for user ${userId}: ${assignedRole}`,
      );
    }
  }

  /**
   * Get SAML strategy for a specific provider
   */
  public getStrategy(providerId: string): SamlStrategy | null {
    const strategyRegistry = passport as unknown as {
      _strategy(name: string): unknown;
    };
    return strategyRegistry._strategy(
      `saml-${providerId}`,
    ) as SamlStrategy | null;
  }

  /**
   * Get all active SSO providers
   */
  public async getActiveProviders(): Promise<SSOProvider[]> {
    const result = await pool.query(
      "SELECT * FROM sso_providers WHERE is_active = true ORDER BY name",
    );
    return result.rows;
  }

  /**
   * Get SSO provider by ID
   */
  public async getProviderById(
    providerId: string,
  ): Promise<SSOProvider | null> {
    const result = await pool.query(
      "SELECT * FROM sso_providers WHERE id = $1",
      [providerId],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Create or update SSO provider
   */
  public async upsertProvider(config: SSOConfig): Promise<SSOProvider> {
    const result = await pool.query(
      `INSERT INTO sso_providers (name, provider_type, entry_point, issuer, cert, callback_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET
         provider_type = EXCLUDED.provider_type,
         entry_point = EXCLUDED.entry_point,
         issuer = EXCLUDED.issuer,
         cert = EXCLUDED.cert,
         callback_url = EXCLUDED.callback_url,
         is_active = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        config.providerName,
        config.providerType,
        config.entryPoint,
        config.issuer,
        config.cert,
        config.callbackUrl,
      ],
    );

    const provider = result.rows[0];

    // Reconfigure strategy
    this.configureSAMLStrategy(provider);

    console.log(`[SSO] Upserted provider: ${provider.name}`);
    return provider;
  }

  /**
   * Add group-to-role mapping
   */
  public async addGroupRoleMapping(
    providerId: string,
    ssoGroupName: string,
    roleId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO sso_group_role_mappings (provider_id, sso_group_name, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider_id, sso_group_name) DO UPDATE SET
         role_id = EXCLUDED.role_id,
         updated_at = CURRENT_TIMESTAMP`,
      [providerId, ssoGroupName, roleId],
    );

    console.log(
      `[SSO] Added group-role mapping: ${ssoGroupName} -> ${roleId} for provider ${providerId}`,
    );
  }

  /**
   * Remove group-to-role mapping
   */
  public async removeGroupRoleMapping(
    providerId: string,
    ssoGroupName: string,
  ): Promise<void> {
    await pool.query(
      "DELETE FROM sso_group_role_mappings WHERE provider_id = $1 AND sso_group_name = $2",
      [providerId, ssoGroupName],
    );

    console.log(
      `[SSO] Removed group-role mapping: ${ssoGroupName} for provider ${providerId}`,
    );
  }

  /**
   * Get group-to-role mappings for a provider
   */
  public async getGroupRoleMappings(
    providerId: string,
  ): Promise<GroupRoleMapping[]> {
    const result = await pool.query(
      `SELECT sgrm.sso_group_name, r.name as role_name, r.id as role_id
       FROM sso_group_role_mappings sgrm
       JOIN roles r ON sgrm.role_id = r.id
       WHERE sgrm.provider_id = $1
       ORDER BY sgrm.sso_group_name`,
      [providerId],
    );
    return result.rows;
  }

  /**
   * Deactivate SSO user (for offboarding)
   */
  public async deactivateUser(userId: string, reason: string): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Get SSO user info
      const ssoUserResult = await client.query(
        "SELECT * FROM sso_users WHERE user_id = $1",
        [userId],
      );

      if (ssoUserResult.rows.length === 0) {
        throw new Error("SSO user not found");
      }

      const ssoUser = ssoUserResult.rows[0];

      // Deactivate SSO user
      await client.query(
        "UPDATE sso_users SET is_active = false WHERE user_id = $1",
        [userId],
      );

      // Log deactivation event
      await client.query(
        `INSERT INTO sso_audit_log (provider_id, user_id, event_type, event_data)
         VALUES ($1, $2, 'user_deactivated', $3)`,
        [
          ssoUser.provider_id,
          userId,
          JSON.stringify({
            reason,
            deactivated_at: new Date().toISOString(),
          }),
        ],
      );

      await client.query("COMMIT");

      console.log(`[SSO] Deactivated SSO user: ${userId}, reason: ${reason}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check if user is SSO-only (cannot use password auth)
   */
  public async isSSOOnlyUser(userId: string): Promise<boolean> {
    const result = await pool.query(
      "SELECT sso_only FROM users WHERE id = $1",
      [userId],
    );
    return result.rows.length > 0 && result.rows[0].sso_only === true;
  }

  /**
   * Get SSO user by user ID
   */
  public async getSSOUserByUserId(userId: string): Promise<SSOUser | null> {
    const result = await pool.query(
      "SELECT * FROM sso_users WHERE user_id = $1",
      [userId],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Get SSO audit log for a user
   */
  public async getAuditLog(userId: string, limit: number = 50): Promise<any[]> {
    const result = await pool.query(
      `SELECT sal.*, sp.name as provider_name
       FROM sso_audit_log sal
       LEFT JOIN sso_providers sp ON sal.provider_id = sp.id
       WHERE sal.user_id = $1
       ORDER BY sal.created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  }

  /**
   * Handle SAML callback and generate JWT tokens
   */
  public async handleSAMLCallback(
    req: Request,
    res: Response,
    providerId: string,
  ): Promise<void> {
    const strategy = this.getStrategy(providerId);

    if (!strategy) {
      res.status(400).json({
        error: "Invalid SSO provider",
        message: "SSO provider not found or not configured",
      });
      return;
    }

    passport.authenticate(
      `saml-${providerId}`,
      async (err: Error | null, user: any) => {
        if (err) {
          console.error("[SSO] SAML authentication error:", err);
          res.status(401).json({
            error: "SSO authentication failed",
            message: err.message,
          });
          return;
        }

        if (!user) {
          res.status(401).json({
            error: "SSO authentication failed",
            message: "No user returned from IdP",
          });
          return;
        }

        try {
          // Generate JWT token
          const token = generateToken({
            userId: user.id,
            email: user.email || "",
          });

          // Generate refresh token
          const refreshToken = await generateRefreshToken(user.id);

          // Store SSO session in Redis for SLO support
          if (user.ssoSubject) {
            await redisClient.set(
              `sso:session:${user.id}`,
              JSON.stringify({
                ssoUserId: user.ssoUserId,
                providerId: user.providerId,
                ssoSubject: user.ssoSubject,
                sessionIndex: user.sessionIndex,
              }),
              { EX: 3600 }, // 1 hour TTL
            );
          }

          res.json({
            message: "SSO login successful",
            token,
            refreshToken,
            user: {
              id: user.id,
              email: user.email,
              groups: user.groups,
            },
          });
        } catch (error) {
          console.error("[SSO] Error generating tokens:", error);
          res.status(500).json({
            error: "Token generation failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      },
    )(req, res);
  }
}

/**
 * Create SSO Router with all SSO endpoints
 */
export function createSSORouter(): Router {
  const router = Router();
  const ssoService = SSOService.getInstance();

  /**
   * GET /api/auth/sso/providers
   * List all active SSO providers
   */
  router.get("/providers", async (req: Request, res: Response) => {
    try {
      const providers = await ssoService.getActiveProviders();
      res.json({
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          provider_type: p.provider_type,
          login_url: `/api/auth/sso/login/${p.id}`,
        })),
      });
    } catch (error) {
      console.error("[SSO] Error fetching providers:", error);
      res.status(500).json({
        error: "Failed to fetch SSO providers",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /api/auth/sso/login/:providerId
   * Initiate SSO login for a specific provider
   */
  router.get("/login/:providerId", async (req: Request, res: Response) => {
    const { providerId } = req.params;

    try {
      const provider = await ssoService.getProviderById(providerId);

      if (!provider) {
        res.status(404).json({
          error: "SSO provider not found",
          message: "The specified SSO provider does not exist",
        });
        return;
      }

      // Redirect to IdP
      passport.authenticate(`saml-${providerId}`, {
        failureRedirect: "/api/auth/sso/error",
        failureFlash: true,
      })(req, res);
    } catch (error) {
      console.error("[SSO] Error initiating SSO login:", error);
      res.status(500).json({
        error: "SSO login initiation failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/auth/sso/callback/:providerId
   * Handle SAML callback from IdP
   */
  router.post("/callback/:providerId", async (req: Request, res: Response) => {
    const { providerId } = req.params;
    await ssoService.handleSAMLCallback(req, res, providerId);
  });

  /**
   * GET /api/auth/sso/error
   * SSO error page
   */
  router.get("/error", (req: Request, res: Response) => {
    res.status(401).json({
      error: "SSO authentication failed",
      message: "An error occurred during SSO authentication",
    });
  });

  /**
   * GET /api/auth/sso/mappings/:providerId
   * Get group-to-role mappings for a provider (admin only)
   */
  router.get("/mappings/:providerId", async (req: Request, res: Response) => {
    const { providerId } = req.params;

    try {
      const mappings = await ssoService.getGroupRoleMappings(providerId);
      res.json({ mappings });
    } catch (error) {
      console.error("[SSO] Error fetching mappings:", error);
      res.status(500).json({
        error: "Failed to fetch group-role mappings",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /api/auth/sso/mappings/:providerId
   * Add group-to-role mapping (admin only)
   */
  router.post("/mappings/:providerId", async (req: Request, res: Response) => {
    const { providerId } = req.params;
    const { sso_group_name, role_id } = req.body;

    if (!sso_group_name || !role_id) {
      res.status(400).json({
        error: "Missing required fields",
        message: "sso_group_name and role_id are required",
      });
      return;
    }

    try {
      await ssoService.addGroupRoleMapping(providerId, sso_group_name, role_id);
      res.json({
        message: "Group-role mapping added successfully",
        mapping: { sso_group_name, role_id },
      });
    } catch (error) {
      console.error("[SSO] Error adding mapping:", error);
      res.status(500).json({
        error: "Failed to add group-role mapping",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * DELETE /api/auth/sso/mappings/:providerId/:groupName
   * Remove group-to-role mapping (admin only)
   */
  router.delete(
    "/mappings/:providerId/:groupName",
    async (req: Request, res: Response) => {
      const { providerId, groupName } = req.params;

      try {
        await ssoService.removeGroupRoleMapping(providerId, groupName);
        res.json({
          message: "Group-role mapping removed successfully",
        });
      } catch (error) {
        console.error("[SSO] Error removing mapping:", error);
        res.status(500).json({
          error: "Failed to remove group-role mapping",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /api/auth/sso/audit/:userId
   * Get SSO audit log for a user (admin only)
   */
  router.get("/audit/:userId", async (req: Request, res: Response) => {
    const { userId } = req.params;
    const limit = Number(req.query.limit) || 50;

    try {
      const auditLog = await ssoService.getAuditLog(userId, limit);
      res.json({ audit_log: auditLog });
    } catch (error) {
      console.error("[SSO] Error fetching audit log:", error);
      res.status(500).json({
        error: "Failed to fetch audit log",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
}

// Export singleton instance
export const ssoService = SSOService.getInstance();
