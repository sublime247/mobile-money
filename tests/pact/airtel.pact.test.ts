/**
 * Pact Consumer Contract Tests — Airtel Money API
 *
 * Defines the contract between our service (consumer) and the Airtel Money
 * API (provider). Covers auth, payment collection, disbursement, status
 * checks, and balance queries.
 */
import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import axios from "axios";

const { like, regex, string } = MatchersV3;

const provider = new PactV3({
  consumer: "MobileMoneyService",
  provider: "AirtelMoneyAPI",
  dir: path.resolve(__dirname, "../../pacts"),
  logLevel: "warn",
});

const BEARER_TOKEN = "test-airtel-bearer-token";
const REFERENCE = "AIRTEL-1700000000000";

describe("Airtel Money API Contract", () => {
  describe("POST /auth/oauth2/token — authenticate", () => {
    it("returns an access token given valid Basic credentials", async () => {
      await provider
        .given("valid Airtel API credentials")
        .uponReceiving("a request for an Airtel access token")
        .withRequest({
          method: "POST",
          path: "/auth/oauth2/token",
          headers: {
            Authorization: regex(
              "^Basic [A-Za-z0-9+/=]+$",
              "Basic dGVzdC1rZXk6dGVzdC1zZWNyZXQ=",
            ),
            "Content-Type": "application/json",
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            access_token: like("eyJhbGciOiJSUzI1NiJ9.airtel"),
            expires_in: like(3600),
            token_type: like("Bearer"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/auth/oauth2/token`,
            null,
            {
              headers: {
                Authorization: "Basic dGVzdC1rZXk6dGVzdC1zZWNyZXQ=",
                "Content-Type": "application/json",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.access_token).toBeDefined();
          expect(typeof res.data.expires_in).toBe("number");
        });
    });
  });

  describe("POST /merchant/v1/payments/ — request payment (collection)", () => {
    it("accepts a valid collection request and returns success", async () => {
      await provider
        .given("Airtel collection service is available")
        .uponReceiving("a request to collect payment from a subscriber")
        .withRequest({
          method: "POST",
          path: "/merchant/v1/payments/",
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "X-Country": like("NG"),
            "X-Currency": like("NGN"),
            "Content-Type": "application/json",
          },
          body: {
            reference: like(REFERENCE),
            subscriber: {
              country: like("NG"),
              currency: like("NGN"),
              msisdn: like("2348012345678"),
            },
            transaction: {
              amount: like(100),
              country: like("NG"),
              currency: like("NGN"),
              id: like(REFERENCE),
            },
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            data: {
              transaction: {
                id: like(REFERENCE),
                status: like("TP"),
              },
            },
            status: {
              code: like("200"),
              success: like(true),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/merchant/v1/payments/`,
            {
              reference: REFERENCE,
              subscriber: {
                country: "NG",
                currency: "NGN",
                msisdn: "2348012345678",
              },
              transaction: {
                amount: 100,
                country: "NG",
                currency: "NGN",
                id: REFERENCE,
              },
            },
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "X-Country": "NG",
                "X-Currency": "NGN",
                "Content-Type": "application/json",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.data.transaction.id).toBeDefined();
        });
    });
  });

  describe("GET /standard/v1/payments/:reference — check transaction status", () => {
    it("returns TS (success) status for a completed transaction", async () => {
      await provider
        .given("Airtel transaction is successful")
        .uponReceiving("a request to check a successful transaction status")
        .withRequest({
          method: "GET",
          path: `/standard/v1/payments/${REFERENCE}`,
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "X-Country": like("NG"),
            "X-Currency": like("NGN"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            data: {
              transaction: {
                id: like(REFERENCE),
                status: "TS",
                message: like("Paid"),
              },
            },
            status: {
              code: like("200"),
              success: like(true),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/standard/v1/payments/${REFERENCE}`,
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "X-Country": "NG",
                "X-Currency": "NGN",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.data.transaction.status).toBe("TS");
        });
    });

    it("returns TF (failed) status for a failed transaction", async () => {
      await provider
        .given("Airtel transaction has failed")
        .uponReceiving("a request to check a failed transaction status")
        .withRequest({
          method: "GET",
          path: `/standard/v1/payments/${REFERENCE}`,
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "X-Country": like("NG"),
            "X-Currency": like("NGN"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            data: {
              transaction: {
                id: like(REFERENCE),
                status: "TF",
                message: like("Insufficient funds"),
              },
            },
            status: {
              code: like("200"),
              success: like(false),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/standard/v1/payments/${REFERENCE}`,
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "X-Country": "NG",
                "X-Currency": "NGN",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.data.transaction.status).toBe("TF");
        });
    });
  });

  describe("POST /standard/v1/disbursements/ — send payout", () => {
    it("accepts a valid disbursement request and returns success", async () => {
      const payoutRef = "AIRTEL-PAYOUT-1700000000000";

      await provider
        .given("Airtel disbursement service is available")
        .uponReceiving("a request to disburse funds to a subscriber")
        .withRequest({
          method: "POST",
          path: "/standard/v1/disbursements/",
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "X-Country": like("NG"),
            "X-Currency": like("NGN"),
            "Content-Type": "application/json",
          },
          body: {
            reference: like(payoutRef),
            payee: {
              msisdn: like("2348012345678"),
            },
            transaction: {
              amount: like(50),
              id: like(payoutRef),
            },
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            data: {
              transaction: {
                id: like(payoutRef),
                status: like("TS"),
              },
            },
            status: {
              code: like("200"),
              success: like(true),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/standard/v1/disbursements/`,
            {
              reference: payoutRef,
              payee: { msisdn: "2348012345678" },
              transaction: { amount: 50, id: payoutRef },
            },
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "X-Country": "NG",
                "X-Currency": "NGN",
                "Content-Type": "application/json",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.data.transaction.id).toBeDefined();
        });
    });
  });

  describe("GET /standard/v1/users/balance — get operational balance", () => {
    it("returns available balance", async () => {
      await provider
        .given("Airtel account has funds")
        .uponReceiving("a request for the Airtel operational balance")
        .withRequest({
          method: "GET",
          path: "/standard/v1/users/balance",
          headers: {
            Authorization: regex(`^Bearer .+$`, `Bearer ${BEARER_TOKEN}`),
            "X-Country": like("NG"),
            "X-Currency": like("NGN"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            data: {
              availableBalance: like("5000.00"),
              currency: like("NGN"),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/standard/v1/users/balance`,
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`,
                "X-Country": "NG",
                "X-Currency": "NGN",
              },
            },
          );
          expect(res.status).toBe(200);
          expect(res.data.data.availableBalance).toBeDefined();
        });
    });
  });
});
