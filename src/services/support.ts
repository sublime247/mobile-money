import logger from "../utils/logger";
/**
 * SupportService — Zendesk/Intercom API Integration
 *
 * Automatically creates support tickets when users dispute transactions.
 * Integrates with Zendesk and/or Intercom APIs to ensure support teams
 * receive all transaction context immediately.
 *
 * Features:
 *   - Create tickets automatically on dispute creation
 *   - Inject transaction metadata securely into tickets
 *   - Handle API timeouts gracefully with retries
 *   - Return instant ticket IDs to users
 *   - Support multiple providers (Zendesk primary, Intercom fallback)
 */

import { Dispute } from "../models/dispute";
import { Transaction } from "../models/transaction";
import { maskSensitiveData } from "../utils/masking";


// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface SupportConfig {
  provider: "zendesk" | "intercom" | "both";
  zendesk: {
    subdomain: string;
    apiToken: string;
    userEmail: string;
    defaultGroupId?: string;
    defaultAssigneeId?: string;
  };
  intercom: {
    accessToken: string;
    adminId?: string;
  };
  timeout: number;
  retryAttempts: number;
  retryDelayMs: number;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function getConfig(): SupportConfig {
  const provider = (process.env.SUPPORT_PROVIDER || "zendesk") as SupportConfig["provider"];

  return {
    provider,
    zendesk: {
      subdomain: process.env.ZENDESK_SUBDOMAIN || "",
      apiToken: process.env.ZENDESK_API_TOKEN || "",
      userEmail: process.env.ZENDESK_USER_EMAIL || "",
      defaultGroupId: process.env.ZENDESK_GROUP_ID,
      defaultAssigneeId: process.env.ZENDESK_ASSIGNEE_ID,
    },
    intercom: {
      accessToken: process.env.INTERCOM_ACCESS_TOKEN || "",
      adminId: process.env.INTERCOM_ADMIN_ID,
    },
    timeout: parseInt(process.env.SUPPORT_API_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
    retryAttempts: parseInt(process.env.SUPPORT_RETRY_ATTEMPTS || String(DEFAULT_RETRY_ATTEMPTS), 10),
    retryDelayMs: parseInt(process.env.SUPPORT_RETRY_DELAY_MS || String(DEFAULT_RETRY_DELAY_MS), 10),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupportTicket {
  id: string;
  externalId: string;
  provider: "zendesk" | "intercom";
  url: string;
  status: string;
  createdAt: Date;
}

export interface CreateTicketResult {
  success: boolean;
  ticket?: SupportTicket;
  error?: string;
  provider: "zendesk" | "intercom";
}

export interface TransactionMetadata {
  transactionId: string;
  referenceNumber: string;
  type: string;
  amount: string;
  currency?: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  status: string;
  createdAt: Date;
  userId?: string | null;
}

export interface DisputeMetadata {
  disputeId: string;
  reason: string;
  priority: string;
  category?: string | null;
  reportedBy?: string | null;
  createdAt: Date;
}

interface ZendeskTicketResponse {
  ticket: {
    id: number;
    url: string;
    status: string;
    created_at: string;
  };
}

interface IntercomConversationResponse {
  type: string;
  id: string;
  created_at: number;
  source: {
    url: string;
  };
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTransactionDetails(txn: TransactionMetadata): string {
  return `
**Transaction Details**
- Reference: ${txn.referenceNumber}
- Type: ${txn.type.toUpperCase()}
- Amount: ${txn.amount} ${txn.currency || "XAF"}
- Status: ${txn.status}
- Provider: ${txn.provider}
- Phone: ${maskSensitiveData(txn.phoneNumber, "phone")}
- Stellar Address: ${maskSensitiveData(txn.stellarAddress, "stellar")}
- Created: ${new Date(txn.createdAt).toISOString()}
${txn.userId ? `- User ID: ${txn.userId}` : ""}
`.trim();
}

function formatDisputeDetails(dispute: DisputeMetadata): string {
  return `
**Dispute Details**
- Dispute ID: ${dispute.disputeId}
- Reason: ${dispute.reason}
- Priority: ${dispute.priority.toUpperCase()}
${dispute.category ? `- Category: ${dispute.category}` : ""}
${dispute.reportedBy ? `- Reported By: ${dispute.reportedBy}` : ""}
- Created: ${new Date(dispute.createdAt).toISOString()}
`.trim();
}

function mapToZendeskPriority(priority: string): "low" | "normal" | "high" | "urgent" {
  const mapping: Record<string, "low" | "normal" | "high" | "urgent"> = {
    low: "low",
    medium: "normal",
    high: "high",
    critical: "urgent",
  };
  return mapping[priority] || "normal";
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (lastError.message.includes("4")) {
        throw lastError;
      }

      if (i < attempts - 1) {
        await sleep(delayMs * Math.pow(2, i));
      }
    }
  }

  throw lastError || new Error("All retry attempts failed");
}

// ---------------------------------------------------------------------------
// Zendesk Integration
// ---------------------------------------------------------------------------

async function createZendeskTicket(
  config: SupportConfig,
  transaction: TransactionMetadata,
  dispute: DisputeMetadata,
  requesterEmail?: string,
): Promise<CreateTicketResult> {
  const { zendesk, timeout, retryAttempts, retryDelayMs } = config;

  if (!zendesk.subdomain || !zendesk.apiToken || !zendesk.userEmail) {
    return {
      success: false,
      error: "Zendesk configuration is incomplete. Missing subdomain, API token, or user email.",
      provider: "zendesk",
    };
  }

  const ticketBody = `
${formatDisputeDetails(dispute)}

---

${formatTransactionDetails(transaction)}

---

**Internal Reference**
- Transaction ID: ${transaction.transactionId}
- Dispute ID: ${dispute.disputeId}
`.trim();

  const ticketData = {
    ticket: {
      subject: `[DISPUTE] Transaction ${transaction.referenceNumber} - ${dispute.reason.slice(0, 50)}`,
      comment: {
        body: ticketBody,
        public: false,
      },
      priority: mapToZendeskPriority(dispute.priority),
      type: "problem",
      tags: [
        "dispute",
        `priority-${dispute.priority}`,
        `provider-${transaction.provider}`,
        transaction.type,
      ],
      custom_fields: [
        { id: "transaction_id", value: transaction.transactionId },
        { id: "dispute_id", value: dispute.disputeId },
        { id: "reference_number", value: transaction.referenceNumber },
      ],
      ...(requesterEmail && {
        requester: { email: requesterEmail, name: dispute.reportedBy || "Customer" },
      }),
      ...(zendesk.defaultGroupId && { group_id: parseInt(zendesk.defaultGroupId, 10) }),
      ...(zendesk.defaultAssigneeId && { assignee_id: parseInt(zendesk.defaultAssigneeId, 10) }),
    },
  };

  const url = `https://${zendesk.subdomain}.zendesk.com/api/v2/tickets.json`;
  const credentials = Buffer.from(`${zendesk.userEmail}/token:${zendesk.apiToken}`).toString("base64");

  try {
    const response = await withRetry(
      async () => {
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${credentials}`,
            },
            body: JSON.stringify(ticketData),
          },
          timeout,
        );

        if (!res.ok) {
          const errorBody = await res.text();
          throw new Error(`Zendesk API error ${res.status}: ${errorBody}`);
        }

        return res;
      },
      retryAttempts,
      retryDelayMs,
    );

    const data = (await response.json()) as ZendeskTicketResponse;

    return {
      success: true,
      provider: "zendesk",
      ticket: {
        id: String(data.ticket.id),
        externalId: String(data.ticket.id),
        provider: "zendesk",
        url: `https://${zendesk.subdomain}.zendesk.com/agent/tickets/${data.ticket.id}`,
        status: data.ticket.status,
        createdAt: new Date(data.ticket.created_at),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Zendesk error";
    logger.error("[SupportService] Zendesk ticket creation failed:", message);

    return {
      success: false,
      error: message,
      provider: "zendesk",
    };
  }
}

// ---------------------------------------------------------------------------
// Intercom Integration
// ---------------------------------------------------------------------------

async function createIntercomConversation(
  config: SupportConfig,
  transaction: TransactionMetadata,
  dispute: DisputeMetadata,
  userExternalId?: string,
): Promise<CreateTicketResult> {
  const { intercom, timeout, retryAttempts, retryDelayMs } = config;

  if (!intercom.accessToken) {
    return {
      success: false,
      error: "Intercom configuration is incomplete. Missing access token.",
      provider: "intercom",
    };
  }

  const messageBody = `
New Dispute Created

${formatDisputeDetails(dispute)}

---

${formatTransactionDetails(transaction)}

---

**Actions Required**
1. Review transaction details
2. Contact customer if needed
3. Investigate and resolve dispute

_Dispute ID: ${dispute.disputeId}_
_Transaction ID: ${transaction.transactionId}_
`.trim();

  const conversationData = userExternalId
    ? {
      from: {
        type: "user",
        user_id: userExternalId,
      },
      body: messageBody,
    }
    : {
      from: {
        type: "admin",
        id: intercom.adminId || "admin",
      },
      to: {
        type: "admin",
        id: intercom.adminId || "admin",
      },
      message_type: "inapp",
      body: messageBody,
      subject: `[DISPUTE] ${transaction.referenceNumber}`,
    };

  const url = "https://api.intercom.io/conversations";

  try {
    const response = await withRetry(
      async () => {
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${intercom.accessToken}`,
              "Intercom-Version": "2.10",
            },
            body: JSON.stringify(conversationData),
          },
          timeout,
        );

        if (!res.ok) {
          const errorBody = await res.text();
          throw new Error(`Intercom API error ${res.status}: ${errorBody}`);
        }

        return res;
      },
      retryAttempts,
      retryDelayMs,
    );

    const data = (await response.json()) as IntercomConversationResponse;

    return {
      success: true,
      provider: "intercom",
      ticket: {
        id: data.id,
        externalId: data.id,
        provider: "intercom",
        url: `https://app.intercom.com/a/inbox/conversation/${data.id}`,
        status: "open",
        createdAt: new Date(data.created_at * 1000),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Intercom error";
    logger.error("[SupportService] Intercom conversation creation failed:", message);

    return {
      success: false,
      error: message,
      provider: "intercom",
    };
  }
}

// ---------------------------------------------------------------------------
// Support Service Class
// ---------------------------------------------------------------------------

export class SupportService {
  private config: SupportConfig;

  constructor() {
    this.config = getConfig();
  }

  async createDisputeTicket(
    dispute: Dispute,
    transaction: Transaction,
    requesterEmail?: string,
    userExternalId?: string,
  ): Promise<{
    results: CreateTicketResult[];
    primaryTicketId?: string;
  }> {
    const transactionMeta: TransactionMetadata = {
      transactionId: transaction.id,
      referenceNumber: transaction.referenceNumber,
      type: transaction.type,
      amount: transaction.amount,
      currency: transaction.currency,
      phoneNumber: transaction.phoneNumber,
      provider: transaction.provider,
      stellarAddress: transaction.stellarAddress,
      status: transaction.status,
      createdAt: transaction.createdAt,
      userId: transaction.userId,
    };

    const disputeMeta: DisputeMetadata = {
      disputeId: dispute.id,
      reason: dispute.reason,
      priority: dispute.priority,
      category: dispute.category,
      reportedBy: dispute.reportedBy,
      createdAt: dispute.createdAt,
    };

    const results: CreateTicketResult[] = [];
    let primaryTicketId: string | undefined;

    switch (this.config.provider) {
      case "zendesk": {
        const result = await createZendeskTicket(
          this.config,
          transactionMeta,
          disputeMeta,
          requesterEmail,
        );
        results.push(result);
        if (result.success && result.ticket) {
          primaryTicketId = result.ticket.id;
        }
        break;
      }

      case "intercom": {
        const result = await createIntercomConversation(
          this.config,
          transactionMeta,
          disputeMeta,
          userExternalId,
        );
        results.push(result);
        if (result.success && result.ticket) {
          primaryTicketId = result.ticket.id;
        }
        break;
      }

      case "both": {
        const [zendeskResult, intercomResult] = await Promise.allSettled([
          createZendeskTicket(this.config, transactionMeta, disputeMeta, requesterEmail),
          createIntercomConversation(this.config, transactionMeta, disputeMeta, userExternalId),
        ]);

        if (zendeskResult.status === "fulfilled") {
          results.push(zendeskResult.value);
          if (zendeskResult.value.success && zendeskResult.value.ticket) {
            primaryTicketId = zendeskResult.value.ticket.id;
          }
        } else {
          results.push({
            success: false,
            error: zendeskResult.reason?.message || "Zendesk request failed",
            provider: "zendesk",
          });
        }

        if (intercomResult.status === "fulfilled") {
          results.push(intercomResult.value);
          if (!primaryTicketId && intercomResult.value.success && intercomResult.value.ticket) {
            primaryTicketId = intercomResult.value.ticket.id;
          }
        } else {
          results.push({
            success: false,
            error: intercomResult.reason?.message || "Intercom request failed",
            provider: "intercom",
          });
        }
        break;
      }
    }

    const successCount = results.filter((r) => r.success).length;
    console.log(
      `[SupportService] Ticket creation completed: ${successCount}/${results.length} successful`,
    );

    return { results, primaryTicketId };
  }

  async addZendeskComment(
    ticketId: string,
    comment: string,
    isPublic = false,
  ): Promise<{ success: boolean; error?: string }> {
    const { zendesk, timeout, retryAttempts, retryDelayMs } = this.config;

    if (!zendesk.subdomain || !zendesk.apiToken || !zendesk.userEmail) {
      return { success: false, error: "Zendesk configuration incomplete" };
    }

    const url = `https://${zendesk.subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`;
    const credentials = Buffer.from(`${zendesk.userEmail}/token:${zendesk.apiToken}`).toString(
      "base64",
    );

    try {
      await withRetry(
        async () => {
          const res = await fetchWithTimeout(
            url,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${credentials}`,
              },
              body: JSON.stringify({
                ticket: {
                  comment: {
                    body: comment,
                    public: isPublic,
                  },
                },
              }),
            },
            timeout,
          );

          if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(`Zendesk API error ${res.status}: ${errorBody}`);
          }

          return res;
        },
        retryAttempts,
        retryDelayMs,
      );

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  }

  async addIntercomReply(
    conversationId: string,
    message: string,
    adminId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { intercom, timeout, retryAttempts, retryDelayMs } = this.config;

    if (!intercom.accessToken) {
      return { success: false, error: "Intercom configuration incomplete" };
    }

    const url = `https://api.intercom.io/conversations/${conversationId}/reply`;

    try {
      await withRetry(
        async () => {
          const res = await fetchWithTimeout(
            url,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${intercom.accessToken}`,
                "Intercom-Version": "2.10",
              },
              body: JSON.stringify({
                message_type: "comment",
                type: "admin",
                admin_id: adminId || intercom.adminId,
                body: message,
              }),
            },
            timeout,
          );

          if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(`Intercom API error ${res.status}: ${errorBody}`);
          }

          return res;
        },
        retryAttempts,
        retryDelayMs,
      );

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  }

  isConfigured(): boolean {
    const { provider, zendesk, intercom } = this.config;

    switch (provider) {
      case "zendesk":
        return !!(zendesk.subdomain && zendesk.apiToken && zendesk.userEmail);
      case "intercom":
        return !!intercom.accessToken;
      case "both":
        return (
          !!(zendesk.subdomain && zendesk.apiToken && zendesk.userEmail) || !!intercom.accessToken
        );
      default:
        return false;
    }
  }

  getConfigurationStatus(): {
    provider: string;
    zendesk: { configured: boolean };
    intercom: { configured: boolean };
  } {
    const { zendesk, intercom } = this.config;

    return {
      provider: this.config.provider,
      zendesk: {
        configured: !!(zendesk.subdomain && zendesk.apiToken && zendesk.userEmail),
      },
      intercom: {
        configured: !!intercom.accessToken,
      },
    };
  }
}

export const supportService = new SupportService();
