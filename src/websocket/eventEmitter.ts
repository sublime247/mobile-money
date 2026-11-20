import logger, { requestContext } from "../utils/logger";

export interface WebSocketMessage {
  type: string;
  data: unknown;
  correlation_id?: string | null;
}

export function serializeTransactionUpdate(
  transactionId: string,
  correlationId?: string | null,
): WebSocketMessage {
  return {
    type: "transaction.updated",
    correlation_id: correlationId ?? null,
    data: { transactionId },
  };
}

export function parseSubscriptionCorrelationId(
  value: unknown,
): string | undefined {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value)
    ? value
    : undefined;
}

export function logWebSocketDispatch(message: WebSocketMessage): void {
  if (
    message.type !== "transaction.updated" &&
    message.type !== "subscribe.ack"
  )
    return;

  // The payment's original correlation ID takes precedence over a callback's context.
  requestContext.run(
    {
      trace_id:
        requestContext.getStore()?.trace_id ?? message.correlation_id ?? "",
      correlation_id: message.correlation_id ?? undefined,
    },
    () =>
      logger.info("WebSocket event dispatched", {
        event: message.type,
        correlation_id: message.correlation_id ?? null,
        transactionId: (message.data as { transactionId: string })
          .transactionId,
      }),
  );
}
