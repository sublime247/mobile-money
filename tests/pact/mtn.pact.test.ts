/**
 * Pact Consumer Contract Tests — MTN MoMo API
 *
 * These tests define the contract between our service (consumer) and the
 * MTN MoMo API (provider). The generated pact files can be shared with the
 * MTN provider team or used to verify our mocks match the real API.
 */
import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import axios from "axios";

const { like, regex, string } = MatchersV3;

const provider = new PactV3({
  consumer: "MobileMoneyService",
  provider: "MTNMoMoAPI",
  dir: path.resolve(__dirname, "../../pacts"),
  logLevel: "warn",
});

const MTN_SUBSCRIPTION_KEY = "test-subscription-key";
const BEARER_TOKEN = "test-bearer-token";
const REFERENCE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("MTN MoMo API Contract", () => {
  describe("POST /collection/token/ — get access token", () => {
    it("returns an access token given valid Basic credentials", async () => {
      await provider
        .given("valid MTN API credentials")
        .uponReceiving("a request for an access token")
        .withRequest({
          method: "POST",
          path: "/collection/token/",
          headers: {
            Authorization: regex(
              "^Basic [A-Za-z0-9+/=]+$",
              "Basic dGVzdC1hcGkta2V5OnRlc3QtYXBpLXNlY3JldA==",
            ),
            "Ocp-Apim-Subscription-Key": string(MTN_SUBSCRIPTION_KEY),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            access_token: like("eyJhbGciOiJSUzI1NiJ9.test"),
            token_type: like("access_token"),
            expires_in: like(3600),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/collection/token/`,
            undefined,
            {
              headers: {
                Authorization: "Basic dGVzdC1hcGkta2V5OnRlc3QtYXBpLXNlY3JldA==",
                "Ocp-Apim-Subscription-Key": MTN_SUBSCRIPTION_KEY,
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.access_token).toBeDefined();
          expect(res.data.expires_in).toBeGreaterThan(0);
        });
    });
  });

  describe("POST /collection/v1_0/requesttopay — initiate payment", () => {
    it("accepts a valid payment request and returns 202", async () => {
      await provider
        .given("MTN collection service is available")
        .uponReceiving("a request to collect payment from a subscriber")
        .withRequest({
          method: "POST",
          path: "/collection/v1_0/requesttopay",
          headers: {
            Authorization: regex("^Bearer .+$", `Bearer ${BEARER_TOKEN}`),
            "Ocp-Apim-Subscription-Key": string(MTN_SUBSCRIPTION_KEY),
            "X-Target-Environment": like("sandbox"),
            "X-Reference-Id": regex(
              "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
              REFERENCE_ID,
            ),
            "Content-Type": "application/json",
          },
          body: {
            amount: like("100"),
            currency: like("EUR"),
            externalId: like("ext-001"),
            payer: {
              partyIdType: "MSISDN",
              partyId: like("46733123450"),
            },
            payerMessage: like("Payment for Stellar deposit"),
            payeeNote: like("Deposit"),
          },
        })
        .willRespondWith({
          status: 202,
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/collection/v1_0/requesttopay`,
            {
              amount: "100",
              currency: "EUR",
              externalId: "ext-001",
              payer: { partyIdType: "MSISDN", partyId: "46733123450" },
              payerMessage: "Payment for Stellar deposit",
              payeeNote: "Deposit",
            },
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "Ocp-Apim-Subscription-Key": MTN_SUBSCRIPTION_KEY,
                "X-Target-Environment": "sandbox",
                "X-Reference-Id": REFERENCE_ID,
                "Content-Type": "application/json",
              },
              validateStatus: () => true,
            },
          );
          expect(res.status).toBe(202);
        });
    });
  });

  describe("GET /collection/v1_0/requesttopay/:referenceId — get transaction status", () => {
    it("returns SUCCESSFUL status for a completed transaction", async () => {
      await provider
        .given("MTN transaction exists and is successful")
        .uponReceiving("a request to get transaction status")
        .withRequest({
          method: "GET",
          path: `/collection/v1_0/requesttopay/${REFERENCE_ID}`,
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "Ocp-Apim-Subscription-Key": string(MTN_SUBSCRIPTION_KEY),
            "X-Target-Environment": like("sandbox"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            amount: like("100"),
            currency: like("EUR"),
            financialTransactionId: like("363440463"),
            externalId: like("ext-001"),
            payer: {
              partyIdType: "MSISDN",
              partyId: like("46733123450"),
            },
            status: "SUCCESSFUL",
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/collection/v1_0/requesttopay/${REFERENCE_ID}`,
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "Ocp-Apim-Subscription-Key": MTN_SUBSCRIPTION_KEY,
                "X-Target-Environment": "sandbox",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.status).toBe("SUCCESSFUL");
        });
    });

    it("returns FAILED status for a failed transaction", async () => {
      await provider
        .given("MTN transaction exists and has failed")
        .uponReceiving("a request to get a failed transaction status")
        .withRequest({
          method: "GET",
          path: `/collection/v1_0/requesttopay/${REFERENCE_ID}`,
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "Ocp-Apim-Subscription-Key": string(MTN_SUBSCRIPTION_KEY),
            "X-Target-Environment": like("sandbox"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            status: "FAILED",
            reason: like("PAYER_NOT_FOUND"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/collection/v1_0/requesttopay/${REFERENCE_ID}`,
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "Ocp-Apim-Subscription-Key": MTN_SUBSCRIPTION_KEY,
                "X-Target-Environment": "sandbox",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.status).toBe("FAILED");
        });
    });
  });

  describe("GET /disbursement/v1_0/account/balance — get operational balance", () => {
    it("returns available balance", async () => {
      await provider
        .given("MTN disbursement account has funds")
        .uponReceiving("a request for the operational balance")
        .withRequest({
          method: "GET",
          path: "/disbursement/v1_0/account/balance",
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "Ocp-Apim-Subscription-Key": string(MTN_SUBSCRIPTION_KEY),
            "X-Target-Environment": like("sandbox"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            availableBalance: like("1000.00"),
            currency: like("EUR"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/disbursement/v1_0/account/balance`,
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "Ocp-Apim-Subscription-Key": MTN_SUBSCRIPTION_KEY,
                "X-Target-Environment": "sandbox",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.availableBalance).toBeDefined();
          expect(res.data.currency).toBeDefined();
        });
    });
  });
});
