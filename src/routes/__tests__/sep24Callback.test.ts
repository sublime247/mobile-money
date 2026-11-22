import express from "express";
import request from "supertest";
import { generateInteractiveUrl, getTransaction } from "../../stellar/sep24";
import { sep24RouteHandler } from "../sep24";

const app = express();
app.use(express.json());
app.use("/sep24", sep24RouteHandler);

describe("SEP-24 Interactive Popup Callback Handler (#1944)", () => {
  it("generates interactive URL with session token and transaction ID", async () => {
    const interactive = await generateInteractiveUrl(
      {
        asset_code: "USDC",
        amount: "100.00",
        account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        token: "test_session_token_123",
      } as any,
      "deposit",
    );

    expect(interactive.id).toBeDefined();
    expect(interactive.url).toContain("token=test_session_token_123");
    expect(interactive.url).toContain(`transaction_id=${interactive.id}`);
  });

  it("handles popup callback, updates status to pending_user_transfer_start, and renders postMessage script", async () => {
    const interactive = await generateInteractiveUrl(
      {
        asset_code: "USDC",
        amount: "50.00",
        account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      } as any,
      "deposit",
    );

    const res = await request(app)
      .get(`/sep24/interactive/callback?transaction_id=${interactive.id}&session_token=abc_token&redirect_url=https://wallet.example.com/done`)
      .expect(200);

    expect(res.text).toContain("sep24_callback");
    expect(res.text).toContain(interactive.id);
    expect(res.text).toContain("pending_user_transfer_start");
    expect(res.text).toContain("https://wallet.example.com/done");

    const updatedTx = getTransaction(interactive.id);
    expect(updatedTx?.status).toBe("pending_user_transfer_start");
  });

  it("returns 400 when transaction_id is missing", async () => {
    await request(app)
      .get("/sep24/interactive/callback")
      .expect(400);
  });
});
