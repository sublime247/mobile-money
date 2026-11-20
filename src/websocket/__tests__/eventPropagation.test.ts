import logger, { requestContext } from "../../utils/logger";
import {
  logWebSocketDispatch,
  parseSubscriptionCorrelationId,
  serializeTransactionUpdate,
} from "../eventEmitter";

describe("WebSocket event propagation", () => {
  it("preserves the payment correlation ID in the Redis round-trip and dispatch log", () => {
    const log = jest.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const event = serializeTransactionUpdate("tx-123", "payment-request");
      const received = JSON.parse(JSON.stringify(event));

      expect(received).toEqual({
        type: "transaction.updated",
        correlation_id: "payment-request",
        data: { transactionId: "tx-123" },
      });
      requestContext.run(
        { trace_id: "callback", correlation_id: "callback-request" },
        () => logWebSocketDispatch(received),
      );
      expect(log).toHaveBeenCalledWith("WebSocket event dispatched", {
        event: "transaction.updated",
        correlation_id: "payment-request",
        transactionId: "tx-123",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("includes a null correlation ID for transactions created before the migration", () => {
    expect(serializeTransactionUpdate("old-tx").correlation_id).toBeNull();
  });

  it.each([null, 123, "", "line\nbreak", "x".repeat(257)])(
    "rejects malformed subscription correlation IDs (%p)",
    (value) => {
      expect(parseSubscriptionCorrelationId(value)).toBeUndefined();
    },
  );

  it("accepts a correlation ID from a subscription", () => {
    expect(parseSubscriptionCorrelationId("client-request-123")).toBe(
      "client-request-123",
    );
  });
});
