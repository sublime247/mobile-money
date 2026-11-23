import { z } from "zod";
import { registry } from "../registry";

export const TransactionRequestSchema = registry.register(
  "TransactionRequest",
  z
    .object({
      amount: z
        .number()
        .positive()
        .max(100000000)
        .openapi({
          example: 5000,
          description: "Transaction amount in the smallest currency unit (e.g., XAF, no decimals). Minimum 100, maximum 1,000,000 per transaction.",
        }),
      phoneNumber: z
        .string()
        .regex(/^\+?\d{10,15}$/)
        .openapi({
          example: "+237670000000",
          description: "Mobile money phone number in E.164 format (+237670000000) or local format. Must match the mobile money provider's network.",
        }),
      provider: z
        .enum(["mtn", "airtel", "orange"])
        .openapi({
          example: "mtn",
          description: "Target mobile money provider. Must match the phone number's network.",
        }),
      stellarAddress: z
        .string()
        .regex(/^G[A-Z2-7]{55}$/)
        .openapi({
          example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          description: "Destination Stellar public key (G...). Must be a valid ed25519 Stellar account. The user must trust the anchor's asset before receiving.",
        }),
      userId: z
        .string()
        .uuid()
        .openapi({
          example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          description: "The authenticated user's UUID. Inferred from the JWT token; may be omitted for admin-initiated transactions.",
        }),
      notes: z
        .string()
        .max(256)
        .optional()
        .openapi({
          example: "School fees payment",
          description: "Optional human-readable memo or reference for the transaction. Max 256 characters.",
        }),
    })
    .openapi("TransactionRequest", { description: "Request payload to initiate a mobile money deposit or withdrawal. Amount is in the local fiat currency (XAF)." }),
);

export const TransactionResponseSchema = registry.register(
  "TransactionResponse",
  z
    .object({
      success: z
        .boolean()
        .openapi({ example: true, description: "Indicates whether the request was accepted for processing." }),
      transactionId: z
        .string()
        .uuid()
        .openapi({
          example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          description: "Unique transaction identifier (UUID v4). Use this ID for subsequent status checks.",
        }),
      referenceNumber: z
        .string()
        .openapi({
          example: "TXN-20240425-001",
          description: "Human-readable reference number. Format: TXN-YYYYMMDD-NNN for deposits, WTH-YYYYMMDD-NNN for withdrawals.",
        }),
      status: z
        .enum([
          "pending",
          "processing",
          "completed",
          "failed",
          "cancelled",
          "review",
          "pending_review",
          "dispute",
          "reversed",
          "clawed_back",
        ])
        .openapi({
          example: "pending",
          description: "Current status of the transaction. New transactions start as 'pending' and move to 'processing' once submitted to the provider.",
        }),
      amount: z
        .number()
        .openapi({ example: 5000, description: "Transaction amount as submitted." }),
      provider: z
        .string()
        .openapi({ example: "mtn", description: "Mobile money provider handling this transaction." }),
      createdAt: z
        .string()
        .datetime()
        .openapi({
          example: "2024-04-25T10:00:00.000Z",
          description: "ISO 8601 timestamp of when the transaction was created.",
        }),
    })
    .openapi("TransactionResponse", { description: "Response returned after successfully initiating a deposit or withdrawal request." }),
);

export const TransactionDetailSchema = registry.register(
  "TransactionDetail",
  z
    .object({
      id: z
        .string()
        .uuid()
        .openapi({
          example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          description: "Unique transaction identifier (UUID v4).",
        }),
      referenceNumber: z
        .string()
        .openapi({
          example: "TXN-20240425-001",
          description: "Human-readable reference number assigned by the system.",
        }),
      type: z
        .enum(["deposit", "withdraw"])
        .openapi({
          example: "deposit",
          description: "Direction of the transaction. 'deposit' = mobile money → Stellar, 'withdraw' = Stellar → mobile money.",
        }),
      status: z
        .enum([
          "pending",
          "processing",
          "completed",
          "failed",
          "cancelled",
          "review",
          "pending_review",
          "dispute",
          "reversed",
          "clawed_back",
        ])
        .openapi({
          example: "completed",
          description: "Current lifecycle status. Terminal states: completed, failed, cancelled.",
        }),
      amount: z
        .number()
        .positive()
        .openapi({ example: 5000, description: "Transaction amount in the local currency." }),
      fee: z
        .number()
        .min(0)
        .optional()
        .openapi({ example: 50, description: "Fee deducted from the amount for processing. Only present after fee calculation." }),
      provider: z
        .string()
        .openapi({ example: "mtn", description: "Mobile money provider handling this transaction." }),
      phoneNumber: z
        .string()
        .openapi({
          example: "+237670000000",
          description: "Mobile money phone number associated with the transaction.",
        }),
      stellarAddress: z
        .string()
        .openapi({
          example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          description: "Stellar account address involved in the transfer.",
        }),
      stellarTransactionHash: z
        .string()
        .optional()
        .openapi({
          example: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          description: "Stellar network transaction hash. Populated once the on-chain operation completes.",
        }),
      notes: z
        .string()
        .max(256)
        .optional()
        .openapi({ example: "School fees payment", description: "User-provided memo attached to this transaction." }),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .openapi({
          description: "Arbitrary key-value metadata attached to the transaction by the caller.",
        }),
      createdAt: z
        .string()
        .datetime()
        .openapi({
          example: "2024-04-25T10:00:00.000Z",
          description: "ISO 8601 timestamp of when the transaction was created.",
        }),
      updatedAt: z
        .string()
        .datetime()
        .openapi({
          example: "2024-04-25T10:05:00.000Z",
          description: "ISO 8601 timestamp of the last status update.",
        }),
    })
    .openapi("TransactionDetail", { description: "Full detail of a single transaction, including Stellar on-chain reference when available." }),
);

export const TransactionListResponseSchema = registry.register(
  "TransactionListResponse",
  z
    .object({
      success: z.boolean().openapi({ example: true }),
      data: z.array(TransactionDetailSchema),
      pagination: z.object({
        total: z
          .number()
          .int()
          .nonnegative()
          .openapi({ example: 120, description: "Total number of transactions matching the query filters." }),
        limit: z
          .number()
          .int()
          .positive()
          .openapi({ example: 20, description: "Maximum number of results returned in this page." }),
        offset: z
          .number()
          .int()
          .min(0)
          .openapi({ example: 0, description: "Offset used for this page (offset-based pagination)." }),
      }),
    })
    .openapi("TransactionListResponse", { description: "Paginated list of transactions with metadata." }),
);

export const UpdateNotesRequestSchema = registry.register(
  "UpdateNotesRequest",
  z
    .object({
      notes: z
        .string()
        .max(256)
        .openapi({ example: "Updated payment note: rent for March", description: "New notes text. Replaces any existing notes. Max 256 characters." }),
    })
    .openapi("UpdateNotesRequest", { description: "Request to update the notes/memo on an existing transaction." }),
);

export const MetadataRequestSchema = registry.register(
  "MetadataRequest",
  z
    .object({
      metadata: z.record(z.string(), z.unknown()).openapi({
        example: { category: "utilities", invoiceId: "INV-001" },
        description: "Key-value metadata to attach. Keys are strings, values can be any JSON-compatible type.",
      }),
    })
    .openapi("MetadataRequest", { description: "Request to set or merge metadata on a transaction." }),
);

export const DeleteMetadataKeysRequestSchema = registry.register(
  "DeleteMetadataKeysRequest",
  z
    .object({
      keys: z
        .array(z.string())
        .min(1)
        .openapi({ example: ["category", "invoiceId"], description: "Array of metadata keys to remove from the transaction." }),
    })
    .openapi("DeleteMetadataKeysRequest", { description: "Request to delete specific metadata keys from a transaction." }),
);
