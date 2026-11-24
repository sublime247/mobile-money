import axios, { AxiosHeaders } from "axios";
import { requestContext } from "../logger";
import {
  attachCorrelationIdInterceptor,
  withCorrelationId,
} from "../correlationIdInterceptor";

describe("attachCorrelationIdInterceptor", () => {
  test("attaches X-Correlation-ID to the request config when inside a request context", () => {
    const client = axios.create({ baseURL: "https://provider.example.test" });
    attachCorrelationIdInterceptor(client);

    const handler = (client.interceptors.request as unknown as {
      handlers: Array<{ fulfilled: (config: unknown) => unknown }>;
    }).handlers[0]?.fulfilled;
    expect(handler).toBeDefined();

    const config = { headers: new AxiosHeaders() };
    const result = requestContext.run(
      { trace_id: "trace-1", correlation_id: "corr-abc-123" },
      () => handler!(config),
    ) as { headers: AxiosHeaders };

    expect(result.headers.get("x-correlation-id")).toBe("corr-abc-123");
  });

  test("does not attach a header when called outside of any request context", () => {
    const client = axios.create({ baseURL: "https://provider.example.test" });
    attachCorrelationIdInterceptor(client);

    const handler = (client.interceptors.request as unknown as {
      handlers: Array<{ fulfilled: (config: unknown) => unknown }>;
    }).handlers[0]?.fulfilled;

    const config = { headers: new AxiosHeaders() };
    const result = handler!(config) as { headers: AxiosHeaders };

    expect(result.headers.get("x-correlation-id")).toBeUndefined();
  });

  test("does not register an interceptor on a separate Axios instance", () => {
    const instrumented = axios.create({ baseURL: "https://provider-a.example.test" });
    attachCorrelationIdInterceptor(instrumented);
    const plain = axios.create({ baseURL: "https://provider-b.example.test" });

    const plainHandlers = (plain.interceptors.request as unknown as { handlers: unknown[] })
      .handlers;
    expect(plainHandlers.filter(Boolean)).toHaveLength(0);
  });
});

describe("withCorrelationId", () => {
  test("adds the X-Correlation-ID header inside a request context", () => {
    const result = requestContext.run(
      { trace_id: "t", correlation_id: "corr-fetch-1" },
      () => withCorrelationId({ method: "POST" }),
    );

    const headers = new Headers(result.headers);
    expect(headers.get("x-correlation-id")).toBe("corr-fetch-1");
    expect(result.method).toBe("POST");
  });

  test("returns the input unchanged outside of a request context", () => {
    const init = { method: "GET" as const };
    const result = withCorrelationId(init);

    expect(result).toBe(init);
  });

  test("does not mutate the RequestInit object passed in", () => {
    const init: RequestInit = { method: "GET" };
    requestContext.run({ trace_id: "t", correlation_id: "corr-2" }, () =>
      withCorrelationId(init),
    );

    expect(init.headers).toBeUndefined();
  });
});
