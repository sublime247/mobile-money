import {
  MPESA_CERTIFICATE_CACHE_TTL_MS,
  clearSafaricomCertificateCache,
  getSafaricomPublicCertificate,
} from "../certificate";

const TEST_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDfzCCAmegAwIBAgIUC4SP/P66w8yb1V+BPJmXa9u3/qIwDQYJKoZIhvcNAQEL
BQAwTzEjMCEGA1UEAwwaU2FmYXJpY29tIFRlc3QgQ2VydGlmaWNhdGUxGzAZBgNV
BAoMEk1vYmlsZSBNb25leSBUZXN0czELMAkGA1UEBhMCS0UwHhcNMjYxMDIwMTE1
ODE1WhcNMzYxMDE3MTE1ODE1WjBPMSMwIQYDVQQDDBpTYWZhcmljb20gVGVzdCBD
ZXJ0aWZpY2F0ZTEbMBkGA1UECgwSTW9iaWxlIE1vbmV5IFRlc3RzMQswCQYDVQQG
EwJLRTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJTmKbG8z/PIkyS5
OSnVh/eVzec9SaXfEfTZKmP11HdqQcDe6vBlBkaHOj7DHsQbW20DXgg6a2BDHUkT
XNBmbUbORMJ1q/WTWIkGlJbPpgzu2m01T675fEPb8HxkB8NmF6ypdBwiKcmyTuaU
JmXSYLck3CFI6iYmtah55xGTXeeH9VjZIYqXuL6xNxmeNll31aN0pX2vhTSNlEoT
ExBmNqIFpa1yf8SnujkaqNWJCVexxfj8Cv7NnJbJ9l8iOZspXrHwqaqVvcyDfYjF
TsJQUcLFQHcTasDeDvm+2ELmg45r8TtC9YgzKT2inqsu/Iec1sxtgXlLU1vuWQLZ
oaI8ZukCAwEAAaNTMFEwHQYDVR0OBBYEFAl+216j+3rt3c+4yno4QVMOgSBuMB8G
A1UdIwQYMBaAFAl+216j+3rt3c+4yno4QVMOgSBuMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBAHerNWyARCiO76JLdhUZnBU8NCxeCaKbuplMaCLr
zXMuoI8D8/vHPlDTQCJa4ol55jZyA/Ulkqb99GCwBLtblzl4H0hj/hpU1EZYHqwo
Qa7d4rYo9XzbSC4Awh5V+V323yhyxoz3tB4ZBTVZ+9sb6WM7P6A7T1vNQ4N1hVa/
5vyWIUatSUEROJSWNmgh962p2KIvxsvc1Jbvl3fzg9ea7Z0UraIHOcgho7NhDmK0
Hjurr9+TDGJDvTVEV2F2MUSjh8cb/Dh5iUXFsD//XF10Ygm6vZ+NnPb3N4Tho/+D
G8Bx2vZEJQZQqcKxmXyxTVZPljBDL1zuceZACVkVNf8Fo5w=
-----END CERTIFICATE-----`;

const TEST_CERTIFICATE_DER = Buffer.from(
  TEST_CERTIFICATE_PEM.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
  "base64",
);

describe("Safaricom certificate retrieval and caching (#2329)", () => {
  beforeEach(() => {
    clearSafaricomCertificateCache();
    delete process.env.MPESA_PUBLIC_CERT;
    delete process.env.MPESA_PUBLIC_KEY;
    delete process.env.MPESA_CERTIFICATE_PEM;
    delete process.env.MPESA_CERTIFICATE_URL;
    delete process.env.SAFARICOM_CERTIFICATE_URL;
    delete process.env.MPESA_CERTIFICATE_CACHE_TTL_MS;
  });

  afterEach(() => {
    clearSafaricomCertificateCache();
    delete process.env.MPESA_PUBLIC_CERT;
    delete process.env.MPESA_CERTIFICATE_URL;
  });

  it("loads an X.509 certificate from env configuration", async () => {
    process.env.MPESA_PUBLIC_CERT = TEST_CERTIFICATE_PEM;

    const loaded = await getSafaricomPublicCertificate();

    expect(loaded.source).toBe("env");
    expect(loaded.certificate).not.toBeNull();
    expect(loaded.certificate?.subject).toContain("Safaricom Test Certificate");
    expect(loaded.expiresAt).toBeGreaterThan(Date.now());
  });

  it("downloads and caches a DER certificate from the configured URL", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => TEST_CERTIFICATE_DER,
    })) as unknown as typeof fetch;

    const now = Date.parse("2027-01-01T00:00:00.000Z");
    const first = await getSafaricomPublicCertificate({
      url: "https://example.test/mpesa.cer",
      fetchImpl,
      now: () => now,
    });
    const second = await getSafaricomPublicCertificate({
      url: "https://example.test/mpesa.cer",
      fetchImpl,
      now: () => now + 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.certificate).not.toBeNull();
    expect(second.pem).toBe(first.pem);
    expect(first.expiresAt).toBe(now + MPESA_CERTIFICATE_CACHE_TTL_MS);
  });

  it("refreshes the cached certificate after the TTL elapses", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => TEST_CERTIFICATE_DER,
    })) as unknown as typeof fetch;

    const now = Date.parse("2027-01-01T00:00:00.000Z");
    await getSafaricomPublicCertificate({
      url: "https://example.test/mpesa.cer",
      fetchImpl,
      now: () => now,
      ttlMs: 1_000,
    });
    await getSafaricomPublicCertificate({
      url: "https://example.test/mpesa.cer",
      fetchImpl,
      now: () => now + 2_000,
      ttlMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired certificate", async () => {
    await expect(
      getSafaricomPublicCertificate({
        pem: TEST_CERTIFICATE_PEM,
        now: () => Date.parse("2037-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("expired");
  });

  it("fails clearly when no certificate is configured", async () => {
    await expect(getSafaricomPublicCertificate()).rejects.toThrow(
      "not configured",
    );
  });
});
