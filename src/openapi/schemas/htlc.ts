/**
 * HTLC domain schemas — derived from src/routes/htlc.ts
 */

import { z } from "zod";
import { registry } from "../registry";

export const HtlcLockRequestSchema = registry.register(
  "HtlcLockRequest",
  z
    .object({
      senderAddress: z
        .string()
        .openapi({
          example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        }),
      receiverAddress: z
        .string()
        .openapi({
          example: "GBVVJJWVHSN5BKPKODEOQHKZXQMQFZAZDXQMQFZAZDXQMQFZAZDXQMQ",
        }),
      tokenAddress: z.string().openapi({ example: "USDC" }),
      amount: z.string().openapi({ example: "100.00" }),
      hashlock: z
        .string()
        .length(64)
        .openapi({ example: "a".repeat(64), description: "64-char hex hash" }),
      timelock: z
        .number()
        .openapi({ example: 1714000000, description: "Unix timestamp" }),
      contractId: z.string().openapi({ example: "contract_abc123" }),
    })
    .openapi("HtlcLockRequest"),
);

export const HtlcClaimRequestSchema = registry.register(
  "HtlcClaimRequest",
  z
    .object({
      claimerAddress: z
        .string()
        .openapi({
          example: "GBVVJJWVHSN5BKPKODEOQHKZXQMQFZAZDXQMQFZAZDXQMQFZAZDXQMQ",
        }),
      preimage: z
        .string()
        .length(64)
        .openapi({
          example: "b".repeat(64),
          description: "64-char hex preimage",
        }),
      contractId: z.string().openapi({ example: "contract_abc123" }),
    })
    .openapi("HtlcClaimRequest"),
);

export const HtlcRefundRequestSchema = registry.register(
  "HtlcRefundRequest",
  z
    .object({
      refunderAddress: z
        .string()
        .openapi({
          example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        }),
      contractId: z.string().openapi({ example: "contract_abc123" }),
    })
    .openapi("HtlcRefundRequest"),
);

export const HtlcTransactionResponseSchema = registry.register(
  "HtlcTransactionResponse",
  z
    .object({
      xdr: z
        .string()
        .openapi({
          description: "Base64-encoded Stellar XDR transaction envelope",
        }),
      hash: z.string().openapi({ description: "Hex-encoded transaction hash" }),
    })
    .openapi("HtlcTransactionResponse"),
);
