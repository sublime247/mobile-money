import express from "express";
import request from "supertest";
import {
  CSRF_COOKIE_NAME,
  csrfProtection,
  generateCsrfToken,
  issueCsrfToken,
  safeEqual,
  verifyCsrfToken,
} from "../csrfProtection";

const SECRET = "test-csrf-secret";
const TTL = 60_000;

function buildApp(now: () => number = Date.now) {
  const app = express();
  app.use(express.json());
  app.post("/login", (_req, res) => {
    const csrfToken = issueCsrfToken(res, { secret: SECRET, ttlMs: TTL, now });
    res.json({ csrfToken });
  });
  const admin = express.Router();
  admin.use(csrfProtection({ secret: SECRET, ttlMs: TTL, now }));
  admin.get("/thing", (_req, res) => res.json({ ok: true }));
  admin.post("/thing", (_req, res) => res.json({ ok: true }));
  admin.put("/thing", (_req, res) => res.json({ ok: true }));
  admin.patch("/thing", (_req, res) => res.json({ ok: true }));
  admin.delete("/thing", (_req, res) => res.json({ ok: true }));
  app.use("/admin", admin);
  return app;
}

const cookie = (token: string) => `${CSRF_COOKIE_NAME}=${token}; sid=abc`;

describe("csrfProtection – token issuance", () => {
  it("sets an HttpOnly SameSite=Strict cookie and echoes the token", async () => {
    const res = await request(buildApp()).post("/login");
    const setCookie = res.headers["set-cookie"][0] as string;

    expect(setCookie).toContain(`${CSRF_COOKIE_NAME}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(res.headers["x-csrf-token"]).toBe(res.body.csrfToken);
    expect(setCookie).toContain(encodeURIComponent(res.body.csrfToken));
  });

  it("generates unpredictable, signed tokens", () => {
    const a = generateCsrfToken({ secret: SECRET });
    const b = generateCsrfToken({ secret: SECRET });
    expect(a).not.toBe(b);
    expect(a.split(".")[0].length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(verifyCsrfToken(a, { secret: SECRET }).valid).toBe(true);
    expect(verifyCsrfToken(a, { secret: "other" })).toEqual({
      valid: false,
      reason: "CSRF_TOKEN_INVALID",
    });
  });
});

describe("csrfProtection – enforcement", () => {
  const app = buildApp();
  const token = generateCsrfToken({ secret: SECRET });

  it.each(["post", "put", "patch", "delete"] as const)(
    "accepts %s with matching header and cookie",
    async (method) => {
      await request(app)
        [method]("/admin/thing")
        .set("Cookie", cookie(token))
        .set("X-CSRF-Token", token)
        .expect(200);
    },
  );

  it("does not require a token for safe methods", async () => {
    await request(app).get("/admin/thing").set("Cookie", cookie(token)).expect(200);
  });

  it("lets cookie-less API clients through (not CSRF-exploitable)", async () => {
    await request(app).post("/admin/thing").expect(200);
  });

  it.each(["post", "put", "patch", "delete"] as const)(
    "rejects %s when the header is missing",
    async (method) => {
      const res = await request(app)
        [method]("/admin/thing")
        .set("Cookie", cookie(token))
        .expect(403);
      expect(res.body.code).toBe("CSRF_TOKEN_MISSING");
    },
  );

  it("rejects when the cookie is missing but other cookies are sent", async () => {
    const res = await request(app)
      .post("/admin/thing")
      .set("Cookie", "sid=abc")
      .set("X-CSRF-Token", token)
      .expect(403);
    expect(res.body.code).toBe("CSRF_TOKEN_MISSING");
  });

  it("rejects mismatched header and cookie", async () => {
    const other = generateCsrfToken({ secret: SECRET });
    const res = await request(app)
      .post("/admin/thing")
      .set("Cookie", cookie(token))
      .set("X-CSRF-Token", other)
      .expect(403);
    expect(res.body.code).toBe("CSRF_TOKEN_MISMATCH");
  });

  it("rejects a forged token that matches in header and cookie but is unsigned", async () => {
    const forged = `${"a".repeat(43)}.${Date.now()}.forged`;
    const res = await request(app)
      .post("/admin/thing")
      .set("Cookie", cookie(forged))
      .set("X-CSRF-Token", forged)
      .expect(403);
    expect(res.body.code).toBe("CSRF_TOKEN_INVALID");
  });

  it("rejects expired tokens", async () => {
    let clock = 1_700_000_000_000;
    const timedApp = buildApp(() => clock);
    const old = generateCsrfToken({ secret: SECRET, now: () => clock });

    await request(timedApp)
      .post("/admin/thing")
      .set("Cookie", cookie(old))
      .set("X-CSRF-Token", old)
      .expect(200);

    clock += TTL + 1;
    const res = await request(timedApp)
      .post("/admin/thing")
      .set("Cookie", cookie(old))
      .set("X-CSRF-Token", old)
      .expect(403);
    expect(res.body.code).toBe("CSRF_TOKEN_EXPIRED");
  });

  it("rejects tokens whose timestamp was tampered with to extend lifetime", async () => {
    const [nonce, , mac] = token.split(".");
    const tampered = `${nonce}.${Date.now() + 10_000}.${mac}`;
    const res = await request(app)
      .post("/admin/thing")
      .set("Cookie", cookie(tampered))
      .set("X-CSRF-Token", tampered)
      .expect(403);
    expect(res.body.code).toBe("CSRF_TOKEN_INVALID");
  });
});

describe("safeEqual", () => {
  it("compares in constant time via crypto.timingSafeEqual", () => {
    const crypto = jest.requireActual("crypto");
    const spy = jest.spyOn(crypto, "timingSafeEqual");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
