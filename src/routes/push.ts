import { Router, Request, Response } from "express";
import { pushNotificationService, pushTokenModel, type PushToken } from "../services/push";
import { GraphQLError } from "graphql";

export interface RegisterPushTokenRequest {
  token: string;
  platform: "ios" | "android";
}

export interface PushTokenResponse {
  id: string;
  token: string;
  platform: string;
  createdAt: string;
  updatedAt: string;
}

function formatPushTokenResponse(token: PushToken): PushTokenResponse {
  return {
    id: token.id,
    token: token.token,
    platform: token.platform,
    createdAt: token.createdAt.toISOString(),
    updatedAt: token.updatedAt.toISOString(),
  };
}

/**
 * Extract user ID from authenticated request
 * This assumes authentication middleware has set req.user or similar
 */
function getUserIdFromRequest(req: Request): string {
  // Try different authentication patterns
  const user = (req as any).user;
  if (user?.id) {
    return user.id;
  }
  
  // For GraphQL context or other auth patterns
  const subject = (req as any).auth?.subject;
  if (subject) {
    return subject;
  }
  
  throw new GraphQLError("User not authenticated", {
    extensions: { code: "UNAUTHENTICATED" },
  });
}

export function createPushRouter(): Router {
  const router = Router();

  /**
   * POST /push/register
   * Register a new FCM token for push notifications
   */
  router.post("/register", async (req: Request, res: Response) => {
    try {
      const userId = getUserIdFromRequest(req);
      const { token, platform }: RegisterPushTokenRequest = req.body;

      if (!token) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Token is required",
        });
      }

      if (!platform) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Platform is required (ios or android)",
        });
      }

      const pushToken = await pushNotificationService.registerToken(
        userId,
        token,
        platform,
      );

      res.status(201).json({
        success: true,
        data: formatPushTokenResponse(pushToken),
      });
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions?.code === "UNAUTHENTICATED") {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      console.error("Failed to register push token:", error);
      res.status(400).json({
        error: "Bad Request",
        message: error.message || "Failed to register push token",
      });
    }
  });

  /**
   * DELETE /push/unregister
   * Unregister a specific FCM token
   */
  router.delete("/unregister", async (req: Request, res: Response) => {
    try {
      const userId = getUserIdFromRequest(req);
      const { token }: { token?: string } = req.body;

      if (!token) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Token is required",
        });
      }

      // Verify the token belongs to the user
      const existingToken = await pushTokenModel.getTokenByToken(token);

      if (!existingToken) {
        return res.status(404).json({
          error: "Not Found",
          message: "Token not found",
        });
      }

      if (existingToken.userId !== userId) {
        return res.status(403).json({
          error: "Forbidden",
          message: "You can only unregister your own tokens",
        });
      }

      await pushTokenModel.deleteToken(token);

      res.status(200).json({
        success: true,
        message: "Token unregistered successfully",
      });
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions?.code === "UNAUTHENTICATED") {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      console.error("Failed to unregister push token:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "Failed to unregister token",
      });
    }
  });

  /**
   * DELETE /push/unregister-all
   * Unregister all FCM tokens for the authenticated user
   */
  router.delete("/unregister-all", async (req: Request, res: Response) => {
    try {
      const userId = getUserIdFromRequest(req);

      await pushTokenModel.deleteTokensByUserId(userId);

      res.status(200).json({
        success: true,
        message: "All tokens unregistered successfully",
      });
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions?.code === "UNAUTHENTICATED") {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      console.error("Failed to unregister all push tokens:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "Failed to unregister tokens",
      });
    }
  });

  /**
   * GET /push/tokens
   * Get all registered tokens for the authenticated user
   */
  router.get("/tokens", async (req: Request, res: Response) => {
    try {
      const userId = getUserIdFromRequest(req);

      const tokens = await pushTokenModel.getTokensByUserId(userId);

      res.status(200).json({
        success: true,
        data: {
          tokens: tokens.map(formatPushTokenResponse),
          count: tokens.length,
        },
      });
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions?.code === "UNAUTHENTICATED") {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      console.error("Failed to fetch push tokens:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "Failed to fetch tokens",
      });
    }
  });

  /**
   * POST /push/test
   * Send a test push notification (for development/testing)
   */
  router.post("/test", async (req: Request, res: Response) => {
    try {
      const userId = getUserIdFromRequest(req);

      const result = await pushNotificationService.sendToUser(userId, {
        title: "Test Notification",
        body: "This is a test push notification from Mobile Money API",
        data: {
          type: "test",
          timestamp: new Date().toISOString(),
        },
      });

      res.status(200).json({
        success: true,
        data: {
          tokensSent: result,
          message: `Test notification sent to ${result} device(s)`,
        },
      });
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions?.code === "UNAUTHENTICATED") {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      console.error("Failed to send test push notification:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "Failed to send test notification",
      });
    }
  });

  return router;
}
