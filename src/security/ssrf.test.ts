import { promises as dnsPromises } from "dns";
import {
  SsrfBlockedError,
  assertSafeWebhookUrl,
  isBlockedIpAddress,
  validateWebhookUrl,
} from "./ssrf";

function expectBlocked(fn: () => unknown, message?: RegExp | string): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SsrfBlockedError);
  expect((error as SsrfBlockedError).code).toBe("SSRF_BLOCKED");
  if (message !== undefined)
    expect(String((error as Error).message)).toMatch(message as RegExp);
}

async function expectAsyncBlocked(
  promise: Promise<unknown>,
  message?: RegExp | string,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SsrfBlockedError);
  if (message !== undefined)
    expect(String((error as Error).message)).toMatch(message as RegExp);
}

describe("assertSafeWebhookUrl (synchronous layer)", () => {
  it("accepts public http/https destinations", () => {
    expect(
      assertSafeWebhookUrl("https://hooks.example.com/events").hostname,
    ).toBe("hooks.example.com");
    expect(assertSafeWebhookUrl("http://example.com:8443/hook").port).toBe(
      "8443",
    );
    expect(assertSafeWebhookUrl("https://8.8.8.8/hook").hostname).toBe(
      "8.8.8.8",
    );
    expect(
      assertSafeWebhookUrl("https://[2606:4700::1111]/hook").hostname,
    ).toBe("[2606:4700::1111]");
  });

  it("rejects malformed and relative URLs", () => {
    expectBlocked(() => assertSafeWebhookUrl("not a url"), /absolute URL/);
    expectBlocked(() => assertSafeWebhookUrl("/hook"), /absolute URL/);
    expectBlocked(() => assertSafeWebhookUrl(""), /absolute URL/);
  });

  it("rejects every scheme except http and https", () => {
    for (const url of [
      "ftp://example.com/hook",
      "file:///etc/passwd",
      "gopher://example.com/",
      "data:text/plain,hi",
      "javascript:alert(1)",
    ]) {
      expectBlocked(() => assertSafeWebhookUrl(url), /not allowed; use http/);
    }
  });

  it("rejects embedded credentials", () => {
    expectBlocked(
      () => assertSafeWebhookUrl("https://user:pass@example.com/hook"),
      /credentials/,
    );
    expectBlocked(
      () => assertSafeWebhookUrl("https://user@example.com/hook"),
      /credentials/,
    );
  });

  it("rejects private, loopback and link-local IPv4 literals", () => {
    const blocked = [
      "http://127.0.0.1/hook",
      "http://127.1.2.3:8080/hook",
      "http://10.0.0.5/hook",
      "http://172.16.4.4/hook",
      "http://172.31.255.255/hook",
      "http://192.168.1.10/hook",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://100.64.0.1/hook", // CGNAT
      "http://0.0.0.0/hook",
      "http://198.18.0.1/hook",
      "http://203.0.113.7/hook", // TEST-NET-3
      "http://224.0.0.1/hook", // multicast
      "http://255.255.255.255/hook",
    ];
    for (const url of blocked) {
      expectBlocked(() => assertSafeWebhookUrl(url), /reserved address/);
    }
  });

  it("rejects IPv4 literals in encodings a URL parser normalises", () => {
    for (const url of [
      "http://0x7f.0.0.1/hook",
      "http://2130706433/hook",
      "http://127.1/hook",
      "http://0177.0.0.1/hook",
      "http://017700000001/hook",
    ]) {
      expectBlocked(() => assertSafeWebhookUrl(url), /reserved address/);
    }
  });

  it("rejects IPv6 literals that are not publicly routable", () => {
    const blocked = [
      "http://[::]/hook",
      "http://[::1]/hook",
      "http://[fc00::1]/hook",
      "http://[fd12:3456::1]/hook",
      "http://[fe80::1]/hook",
      "http://[ff02::1]/hook",
      "http://[::ffff:127.0.0.1]/hook", // IPv4-mapped loopback
      "http://[::ffff:10.0.0.1]/hook",
      "http://[64:ff9b::7f00:1]/hook", // NAT64
      "http://[2001:db8::1]/hook", // documentation
      "http://[2002:7f00:1::]/hook", // 6to4 wrapping 127.0.0.1
    ];
    for (const url of blocked) {
      expectBlocked(() => assertSafeWebhookUrl(url));
    }
    // Serialised in hex by the URL parser, but judged as 8.8.8.8.
    expect(assertSafeWebhookUrl("http://[::ffff:8.8.8.8]/hook").hostname).toBe(
      "[::ffff:808:808]",
    );
  });

  it("rejects hostnames that can only resolve internally", () => {
    const blocked = [
      "http://localhost/hook",
      "http://localhost:3000/hook",
      "http://api.localhost/hook",
      "http://db.internal/hook",
      "http://printer.local/hook",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://intranet/hook", // single label, no public suffix
      "http://build/hook",
      "http://nas.lan/hook",
      "http://router.home.arpa/hook",
    ];
    for (const url of blocked) {
      expectBlocked(() => assertSafeWebhookUrl(url), /not allowed/);
    }
  });

  it("rejects port 0 but keeps other ports", () => {
    expectBlocked(() => assertSafeWebhookUrl("http://example.com:0/hook"));
    expect(assertSafeWebhookUrl("http://example.com:9090/hook").port).toBe(
      "9090",
    );
  });

  it("exposes the offending URL on the error", () => {
    try {
      assertSafeWebhookUrl("http://169.254.169.254/");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).destination).toBe(
        "http://169.254.169.254/",
      );
    }
  });
});

describe("isBlockedIpAddress", () => {
  it("blocks private ranges and allows public ones", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.100.100.100",
      "0.1.2.3",
      "239.1.1.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "ff02::1",
      "not-an-ip",
      "999.1.1.1",
    ]) {
      expect(isBlockedIpAddress(ip)).toBe(true);
    }
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700::1111",
    ]) {
      expect(isBlockedIpAddress(ip)).toBe(false);
    }
  });
});

describe("validateWebhookUrl (DNS layer)", () => {
  const publicResolver = async () => ["93.184.216.34", "2606:4700::1111"];

  it("passes when every resolved address is public", async () => {
    const url = await validateWebhookUrl("https://hooks.example.com/hook", {
      resolve: publicResolver,
    });
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expectAsyncBlocked(
      validateWebhookUrl("https://rebind.example.com/hook", {
        resolve: async () => ["93.184.216.34", "10.0.0.5"],
      }),
      /resolves to a private or reserved address \(10\.0\.0\.5\)/,
    );
  });

  it("rejects a hostname that resolves to loopback or link-local", async () => {
    await expectAsyncBlocked(
      validateWebhookUrl("http://internal.example/hook", {
        resolve: async () => ["127.0.0.1"],
      }),
      /private or reserved address/,
    );
    await expectAsyncBlocked(
      validateWebhookUrl("http://internal.example/hook", {
        resolve: async () => ["fe80::1"],
      }),
      /private or reserved address/,
    );
  });

  it("fails closed when the hostname cannot be resolved", async () => {
    await expectAsyncBlocked(
      validateWebhookUrl("https://ghost.example.com/hook", {
        resolve: async () => {
          const err = new Error("getaddrinfo ENOTFOUND ghost.example.com");
          (err as NodeJS.ErrnoException).code = "ENOTFOUND";
          throw err;
        },
      }),
      /could not be resolved/,
    );
    await expectAsyncBlocked(
      validateWebhookUrl("https://ghost.example.com/hook", {
        resolve: async () => [],
      }),
      /could not be resolved/,
    );
  });

  it("still runs an injected resolver when DNS checking is disabled", async () => {
    const previous = process.env.WEBHOOK_SSRF_RESOLVE_DNS;
    process.env.WEBHOOK_SSRF_RESOLVE_DNS = "false";
    try {
      await expectAsyncBlocked(
        validateWebhookUrl("https://rebind.example.com/hook", {
          resolve: async () => ["192.168.1.1"],
        }),
        /private or reserved address/,
      );
    } finally {
      process.env.WEBHOOK_SSRF_RESOLVE_DNS = previous;
    }
  });

  it("skips resolution when DNS checking is disabled", async () => {
    const previous = process.env.WEBHOOK_SSRF_RESOLVE_DNS;
    process.env.WEBHOOK_SSRF_RESOLVE_DNS = "false";
    const lookupSpy = jest.spyOn(dnsPromises, "lookup");
    try {
      const url = await validateWebhookUrl("https://unresolvable.example/hook");
      expect(url.hostname).toBe("unresolvable.example");
      expect(lookupSpy).not.toHaveBeenCalled();
    } finally {
      lookupSpy.mockRestore();
      process.env.WEBHOOK_SSRF_RESOLVE_DNS = previous;
    }
  });

  it("skips resolution for IP literals, which layer 1 already vetted", async () => {
    const resolve = jest.fn();
    await expectAsyncBlocked(
      validateWebhookUrl("http://169.254.169.254/", { resolve }),
      /reserved address/,
    );
    expect(resolve).not.toHaveBeenCalled();

    const url = await validateWebhookUrl("https://8.8.8.8/hook", { resolve });
    expect(url.hostname).toBe("8.8.8.8");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects blocked schemes before doing any DNS work", async () => {
    const resolve = jest.fn();
    await expectAsyncBlocked(
      validateWebhookUrl("ftp://example.com/hook", { resolve }),
      /not allowed; use http/,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});
