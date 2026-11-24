import request from "supertest";
import { createMockServerApp } from "../providerMockServer";

describe("Provider Mock Server - Orange Money Callback /mock/orange/callback", () => {
  const app = createMockServerApp();

  it("returns accepted with SUCCESSFUL status by default", async () => {
    const res = await request(app)
      .post("/mock/orange/callback")
      .send({ reference: "org-ref-123", amount: 5000, currency: "XOF" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.reference).toBe("org-ref-123");
    expect(res.body.transactionStatus).toBe("SUCCESSFUL");
  });

  it("triggers failure responses when scenario=failed via query/header", async () => {
    const res = await request(app)
      .post("/mock/orange/callback?scenario=failed")
      .send({ reference: "org-ref-fail" });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.reference).toBe("org-ref-fail");
    expect(res.body.failureReason).toBeDefined();
  });

  it("triggers pending responses when scenario=pending via header", async () => {
    const res = await request(app)
      .post("/mock/orange/callback")
      .set("x-mock-scenario", "pending")
      .send({ reference: "org-ref-pending" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.transactionStatus).toBe("PENDING");
  });
});
