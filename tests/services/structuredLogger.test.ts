import { buildStructuredLogEntry } from "../../src/services/structuredLogger";

describe("structured logger", () => {
  it("promotes JSON console payloads into searchable fields", () => {
    const entry = buildStructuredLogEntry("info", [
      JSON.stringify({
        timestamp: "2026-03-27T12:00:00.000Z",
        method: "GET",
        path: "/health",
        statusCode: 200,
      }),
    ]);

    expect(entry["@timestamp"]).toBe("2026-03-27T12:00:00.000Z");
    expect(entry.event.dataset).toBe("http.request");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/health");
    expect(entry.statusCode).toBe(200);
  });

  it("serializes errors and preserves the requested log level", () => {
    const error = new Error("boom");
    const entry = buildStructuredLogEntry("error", [
      "Processing failed",
      error,
    ]);

    expect(entry.log.level).toBe("error");
    expect(entry.message).toContain("Processing failed");
    expect(entry.error).toMatchObject({
      name: "Error",
      message: "boom",
    });
  });

  it("keeps session anomaly events under a searchable event object", () => {
    const entry = buildStructuredLogEntry("warn", [
      {
        event: "session.ip_mismatch",
        sessionId: "session-1",
        method: "POST",
        path: "/api/transactions",
      },
    ]);

    expect(entry.event.dataset).toBe("security.session");
    expect(entry.event.action).toBe("session.ip_mismatch");
    expect(entry.sessionId).toBe("session-1");
  });
});
