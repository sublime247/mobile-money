import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import axios from "axios";

const { like, regex, string } = MatchersV3;

const provider = new PactV3({
  consumer: "BridgeClient",
  provider: "ComplianceController",
  dir: path.resolve(__dirname, "../../pacts"),
  logLevel: "warn",
});

describe("Compliance Controller Contract", () => {
  describe("POST /api/v1/compliance/travel-rule/check", () => {
    it("returns applies: false when amount is below threshold", async () => {
      await provider
        .given("Travel rule threshold is 1000 USD")
        .uponReceiving("A check request for amount below threshold")
        .withRequest({
          method: "POST",
          path: "/api/v1/compliance/travel-rule/check",
          headers: {
            "Content-Type": "application/json",
          },
          body: {
            transactionId: like("tx-12345"),
            amount: like(500),
            currency: string("USD"),
            sender: {
              name: string("Alice"),
              account: string("+1234567890"),
            },
            receiver: {
              name: string("Bob"),
              account: string("+0987654321"),
            },
          },
        })
        .willRespondWith({
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          body: {
            applies: false,
            threshold: like(1000),
            message: regex(
              ".*below the Travel Rule threshold.*",
              "Amount 500 USD is below the Travel Rule threshold of $1000",
            ),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/api/v1/compliance/travel-rule/check`,
            {
              transactionId: "tx-12345",
              amount: 500,
              currency: "USD",
              sender: { name: "Alice", account: "+1234567890" },
              receiver: { name: "Bob", account: "+0987654321" },
            },
            {
              headers: { "Content-Type": "application/json" },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.applies).toBe(false);
        });
    });

    it("returns applies: true and captures record when amount meets threshold", async () => {
      await provider
        .given("Travel rule threshold is 1000 USD")
        .uponReceiving("A check request for amount above threshold")
        .withRequest({
          method: "POST",
          path: "/api/v1/compliance/travel-rule/check",
          headers: {
            "Content-Type": "application/json",
          },
          body: {
            transactionId: like("tx-99999"),
            amount: like(1500),
            currency: string("USD"),
            sender: {
              name: string("Alice"),
              account: string("+1234567890"),
            },
            receiver: {
              name: string("Bob"),
              account: string("+0987654321"),
            },
          },
        })
        .willRespondWith({
          status: 201,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          body: {
            applies: true,
            threshold: like(1000),
            record: {
              id: regex(
                "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                "123e4567-e89b-12d3-a456-426614174000",
              ),
              transactionId: like("tx-99999"),
              amount: like(1500),
              currency: like("USD"),
              createdAt: regex(
                "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}.*",
                "2026-08-26T00:00:00.000Z",
              ),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/api/v1/compliance/travel-rule/check`,
            {
              transactionId: "tx-99999",
              amount: 1500,
              currency: "USD",
              sender: { name: "Alice", account: "+1234567890" },
              receiver: { name: "Bob", account: "+0987654321" },
            },
            {
              headers: { "Content-Type": "application/json" },
            },
          );
          expect(res.status).toBe(201);
          expect(res.data.applies).toBe(true);
          expect(res.data.record.transactionId).toBeDefined();
        });
    });

    it("returns 400 for invalid input", async () => {
      await provider
        .given("Travel rule threshold is 1000 USD")
        .uponReceiving("An invalid check request missing transactionId")
        .withRequest({
          method: "POST",
          path: "/api/v1/compliance/travel-rule/check",
          headers: {
            "Content-Type": "application/json",
          },
          body: {
            amount: like(1500),
            currency: string("USD"),
            sender: {
              name: string("Alice"),
              account: string("+1234567890"),
            },
            receiver: {
              name: string("Bob"),
              account: string("+0987654321"),
            },
          },
        })
        .willRespondWith({
          status: 400,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          body: {
            error: like("Validation failed"),
            details: like({
              transactionId: ["Required"],
            }),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/api/v1/compliance/travel-rule/check`,
            {
              amount: 1500,
              currency: "USD",
              sender: { name: "Alice", account: "+1234567890" },
              receiver: { name: "Bob", account: "+0987654321" },
            },
            {
              headers: { "Content-Type": "application/json" },
              validateStatus: () => true,
            },
          );
          expect(res.status).toBe(400);
          expect(res.data.error).toBeDefined();
        });
    });
  });
});
