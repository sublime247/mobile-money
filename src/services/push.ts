import * as admin from "firebase-admin";
import { pool } from "../config/database";


export interface PushToken {
  id: string;
  userId: string;
  token: string;
  platform: "ios" | "android";
  createdAt: Date;
  updatedAt: Date;
}

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export interface TransactionNotificationData {
  transactionId: string;
  referenceNumber: string;
  type: "deposit" | "withdraw";
  amount: string;
  status: "completed" | "failed";
  error?: string;
  data?: Record<string, string>;
}


/**
 * Initialize Firebase Admin SDK
 * Uses FIREBASE_SERVICE_ACCOUNT_KEY environment variable (JSON string or path)
 */
function initializeFirebase(): admin.app.App | null {
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  
  if (!serviceAccountKey) {
    console.warn("Firebase Admin: FIREBASE_SERVICE_ACCOUNT_KEY not configured. Push notifications disabled.");
    return null;
  }

  try {
    // Check if already initialized
    if (admin.apps.length > 0) {
      return admin.app();
    }

    // Try to parse as JSON first
    let serviceAccount: any;
    try {
      serviceAccount = JSON.parse(serviceAccountKey);
    } catch {
      // If parsing fails, treat as file path
      serviceAccount = require(serviceAccountKey);
    }

    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error("Firebase Admin initialization failed:", error);
    return null;
  }
}

// Initialize Firebase on module load
const firebaseApp = initializeFirebase();


export class PushTokenModel {
  /**
   * Store or update a user's FCM token
   */
  async upsertToken(
    userId: string,
    token: string,
    platform: "ios" | "android",
  ): Promise<PushToken> {
    const result = await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE
       SET user_id = $1, platform = $3, updated_at = CURRENT_TIMESTAMP
       RETURNING id, user_id AS "userId", token, platform, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [userId, token, platform],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.userId,
      token: row.token,
      platform: row.platform,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Get all tokens for a user
   */
  async getTokensByUserId(userId: string): Promise<PushToken[]> {
    const result = await pool.query(
      `SELECT id, user_id AS "userId", token, platform, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM push_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      userId: row.userId,
      token: row.token,
      platform: row.platform,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Get token by its value
   */
  async getTokenByToken(token: string): Promise<PushToken | null> {
    const result = await pool.query(
      `SELECT id, user_id AS "userId", token, platform, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM push_tokens
       WHERE token = $1`,
      [token],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.userId,
      token: row.token,
      platform: row.platform,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Delete a token (e.g., when it becomes invalid)
   */
  async deleteToken(token: string): Promise<void> {
    await pool.query("DELETE FROM push_tokens WHERE token = $1", [token]);
  }

  /**
   * Delete all tokens for a user
   */
  async deleteTokensByUserId(userId: string): Promise<void> {
    await pool.query("DELETE FROM push_tokens WHERE user_id = $1", [userId]);
  }

  /**
   * Clean up old/unused tokens (older than 90 days)
   */
  async cleanupOldTokens(): Promise<number> {
    const result = await pool.query(
      `DELETE FROM push_tokens
       WHERE updated_at < NOW() - INTERVAL '90 days'
       RETURNING id`,
    );
    return result.rowCount || 0;
  }
}


export class PushNotificationService {
  private tokenModel: PushTokenModel;
  private isEnabled: boolean;

  constructor() {
    this.tokenModel = new PushTokenModel();
    this.isEnabled = firebaseApp !== null;
  }

  /**
   * Check if push notifications are enabled
   */
  isAvailable(): boolean {
    return this.isEnabled;
  }

  /**
   * Register a new FCM token for a user
   */
  async registerToken(
    userId: string,
    token: string,
    platform: "ios" | "android",
  ): Promise<PushToken> {
    // Validate token format
    if (!token || token.length < 10) {
      throw new Error("Invalid push token format");
    }

    if (!["ios", "android"].includes(platform)) {
      throw new Error("Invalid platform. Must be 'ios' or 'android'");
    }

    return this.tokenModel.upsertToken(userId, token, platform);
  }

  /**
   * Send a push notification to a specific token
   */
  async sendToToken(
    token: string,
    notification: PushNotification,
  ): Promise<boolean> {
    if (!this.isEnabled) {
      console.warn("Push notifications disabled. Skipping send.");
      return false;
    }

    try {
      const message: admin.messaging.Message = {
        token,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: notification.data,
        android: {
          priority: "high",
          notification: {
            channelId: "transactions",
            sound: "default",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              category: "TRANSACTION",
            },
          },
        },
      };

      if (notification.imageUrl) {
        message.android!.notification!.imageUrl = notification.imageUrl;
      }

      const response = await admin.messaging().send(message);
      console.log("Push notification sent successfully:", response);
      return true;
    } catch (error: any) {
      // Handle invalid/expired tokens
      if (this.isInvalidTokenError(error)) {
        console.log("Invalid/expired token, removing from database:", token);
        await this.tokenModel.deleteToken(token);
        return false;
      }

      console.error("Failed to send push notification:", error);
      return false;
    }
  }

  /**
   * Send push notifications to all of a user's devices
   */
  async sendToUser(
    userId: string,
    notification: PushNotification,
  ): Promise<number> {
    const tokens = await this.tokenModel.getTokensByUserId(userId);
    
    if (tokens.length === 0) {
      console.warn("No push tokens found for user:", userId);
      return 0;
    }

    let successCount = 0;
    for (const tokenRecord of tokens) {
      const success = await this.sendToToken(tokenRecord.token, notification);
      if (success) {
        successCount++;
      }
    }

    return successCount;
  }

  /**
   * Send transaction completion notification
   */
  async sendTransactionComplete(
    userId: string,
    data: TransactionNotificationData,
  ): Promise<number> {
    const notification: PushNotification = {
      title: data.type === "deposit" ? "Deposit Successful" : "Withdrawal Complete",
      body: `${data.type === "deposit" ? "Received" : "Sent"} ${data.amount} - Ref: ${data.referenceNumber}`,
      data: {
        type: "transaction_complete",
        transactionId: data.transactionId,
        referenceNumber: data.referenceNumber,
        status: data.status,
        ...data.data,
      },
    };

    return this.sendToUser(userId, notification);
  }

  /**
   * Send transaction failure notification
   */
  async sendTransactionFailed(
    userId: string,
    data: TransactionNotificationData,
  ): Promise<number> {
    const notification: PushNotification = {
      title: data.type === "deposit" ? "Deposit Failed" : "Withdrawal Failed",
      body: data.error || `Your ${data.type} transaction could not be completed.`,
      data: {
        type: "transaction_failed",
        transactionId: data.transactionId,
        referenceNumber: data.referenceNumber,
        status: data.status,
        error: data.error || "unknown",
        ...data.data,
      },
    };

    return this.sendToUser(userId, notification);
  }

  /**
   * Check if an error indicates an invalid/expired token
   */
  private isInvalidTokenError(error: any): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const errorCode = error.code || error.error?.code;
    const errorMessage = error.message || error.error?.message || "";

    const invalidTokenCodes = [
      "messaging/invalid-registration-token",
      "messaging/registration-token-not-registered",
      "messaging/invalid-argument",
      "UNREGISTERED",
      "NOT_FOUND",
    ];

    const invalidTokenMessages = [
      "The registration token is not a valid FCM registration token",
      "The requested entity was not found",
      "Requested entity was not found",
      "APNS device token not set before attempting to send Apple Push Notification",
    ];

    return (
      invalidTokenCodes.some((code) => errorCode?.includes?.(code)) ||
      invalidTokenMessages.some((msg) => errorMessage.includes(msg))
    );
  }

  /**
   * Get the token model for direct access
   */
  getTokenModel(): PushTokenModel {
    return this.tokenModel;
  }
}

// Export singleton instance
export const pushNotificationService = new PushNotificationService();
export const pushTokenModel = new PushTokenModel();
