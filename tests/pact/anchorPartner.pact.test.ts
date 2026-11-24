/**
 * Pact Consumer Contract Tests — External Anchor Partner API Integrations (#2514)
 *
 * Defines and asserts consumer contracts for external partner anchor integrations:
 *   1. SEP-31 Cross-Border Remittance / Exchange API:
 *      - POST /sep31/transactions (initiate remittance payment)
 *      - GET  /sep31/transactions/:id (query remittance transaction status)
 *      - GET  /sep31/info (discover anchor supported corridors and limits)
 *   2. SEP-12 KYC Customer API:
 *      - GET  /sep12/customer (fetch KYC requirements and approval status)
 *      - PUT  /sep12/customer (submit customer identity attributes)
 *
 * Generated pact file: pacts/AnchorPartnerConsumer-AnchorPartnerAPI.json
 */

import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import axios from "axios";

const { like, regex, string, integer, boolean } = MatchersV3;

const provider = new PactV3({
  consumer: "AnchorPartnerConsumer",
  provider: "AnchorPartnerAPI",
  dir: path.resolve(__dirname, "../../pacts"),
  logLevel: "warn",
});

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const STELLAR_ACCOUNT_REGEX = "^G[A-Z0-9]{55}$";
const DECIMAL_STRING_REGEX = "^\\d+(\\.\\d+)?$";

describe("Anchor Partner Integration Contracts (#2514)", () => {
  describe("SEP-31 Cross-Border Remittance Exchange", () => {
    describe("POST /sep31/transactions", () => {
      it("creates a remittance transaction and returns payment instructions with stellar memo", async () => {
        await provider
          .given("Anchor is ready to receive remittance payments for USDC")
          .uponReceiving("A request to initiate a SEP-31 remittance transaction")
          .withRequest({
            method: "POST",
            path: "/sep31/transactions",
            headers: {
              "Content-Type": "application/json",
            },
            body: {
              amount: "100.00",
              asset_code: "USDC",
              sender_id: "cust-sender-101",
              receiver_id: "cust-receiver-202",
              fields: {
                transaction: {
                  receiver_account_number: "+254712345678",
                },
              },
            },
          })
          .willRespondWith({
            status: 201,
            headers: JSON_HEADERS,
            body: {
              id: string("sep31-tx-12345"),
              status: string("pending_sender"),
              amount_in: regex(DECIMAL_STRING_REGEX, "100.00"),
              amount_out: regex(DECIMAL_STRING_REGEX, "12950.00"),
              amount_fee: regex(DECIMAL_STRING_REGEX, "1.00"),
              stellar_account_id: regex(
                STELLAR_ACCOUNT_REGEX,
                "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBR54EB4YAWUEHPLSSH56TM2IB",
              ),
              stellar_memo: string("123456"),
              stellar_memo_type: string("text"),
            },
          })
          .executeTest(async (mockServer) => {
            const res = await axios.post(
              `${mockServer.url}/sep31/transactions`,
              {
                amount: "100.00",
                asset_code: "USDC",
                sender_id: "cust-sender-101",
                receiver_id: "cust-receiver-202",
                fields: {
                  transaction: {
                    receiver_account_number: "+254712345678",
                  },
                },
              },
              {
                headers: { "Content-Type": "application/json" },
              },
            );

            expect(res.status).toBe(201);
            expect(res.data.id).toBe("sep31-tx-12345");
            expect(res.data.status).toBe("pending_sender");
            expect(res.data.stellar_memo).toBe("123456");
            expect(res.data.stellar_memo_type).toBe("text");
            expect(res.data.stellar_account_id).toMatch(/^G[A-Z0-9]{55}$/);
          });
      });
    });

    describe("GET /sep31/transactions/:id", () => {
      it("retrieves status and details of an existing remittance transaction", async () => {
        await provider
          .given("Remittance transaction sep31-tx-12345 exists and is completed")
          .uponReceiving("A request to get transaction details by ID")
          .withRequest({
            method: "GET",
            path: "/sep31/transactions/sep31-tx-12345",
          })
          .willRespondWith({
            status: 200,
            headers: JSON_HEADERS,
            body: {
              transaction: {
                id: string("sep31-tx-12345"),
                status: regex(
                  "^(pending_sender|pending_stellar|pending_receiver|pending_external|completed|error)$",
                  "completed",
                ),
                amount_in: regex(DECIMAL_STRING_REGEX, "100.00"),
                amount_out: regex(DECIMAL_STRING_REGEX, "12950.00"),
                amount_fee: regex(DECIMAL_STRING_REGEX, "1.00"),
                stellar_transaction_id: like(
                  "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
                ),
              },
            },
          })
          .executeTest(async (mockServer) => {
            const res = await axios.get(
              `${mockServer.url}/sep31/transactions/sep31-tx-12345`,
            );

            expect(res.status).toBe(200);
            expect(res.data.transaction.id).toBe("sep31-tx-12345");
            expect(res.data.transaction.status).toBe("completed");
            expect(res.data.transaction.amount_in).toBe("100.00");
          });
      });
    });

    describe("GET /sep31/info", () => {
      it("returns anchor receiving info and asset support matrix", async () => {
        await provider
          .given("Anchor configuration is active")
          .uponReceiving("A request for SEP-31 anchor info")
          .withRequest({
            method: "GET",
            path: "/sep31/info",
          })
          .willRespondWith({
            status: 200,
            headers: JSON_HEADERS,
            body: {
              receive: {
                USDC: {
                  enabled: boolean(true),
                  fee_fixed: like(0),
                  fee_percent: like(1),
                  min_amount: like(1),
                  max_amount: like(10000),
                },
              },
            },
          })
          .executeTest(async (mockServer) => {
            const res = await axios.get(`${mockServer.url}/sep31/info`);
            expect(res.status).toBe(200);
            expect(res.data.receive.USDC.enabled).toBe(true);
            expect(res.data.receive.USDC.min_amount).toBe(1);
          });
      });
    });
  });

  describe("SEP-12 Customer KYC Verification", () => {
    describe("GET /sep12/customer", () => {
      it("returns customer KYC verification status and fields", async () => {
        const testAccount = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBR54EB4YAWUEHPLSSH56TM2IB";
        await provider
          .given("Customer KYC record exists for stellar account")
          .uponReceiving("A request for customer KYC status")
          .withRequest({
            method: "GET",
            path: "/sep12/customer",
            query: {
              account: testAccount,
            },
          })
          .willRespondWith({
            status: 200,
            headers: JSON_HEADERS,
            body: {
              id: string("cust-123"),
              status: regex("^(ACCEPTED|PROCESSING|NEEDS_INFO|REJECTED)$", "ACCEPTED"),
              fields: {
                first_name: {
                  type: string("string"),
                  description: string("Customer first name"),
                  optional: boolean(false),
                },
                last_name: {
                  type: string("string"),
                  description: string("Customer last name"),
                  optional: boolean(false),
                },
              },
            },
          })
          .executeTest(async (mockServer) => {
            const res = await axios.get(`${mockServer.url}/sep12/customer`, {
              params: { account: testAccount },
            });

            expect(res.status).toBe(200);
            expect(res.data.id).toBe("cust-123");
            expect(res.data.status).toBe("ACCEPTED");
            expect(res.data.fields.first_name.optional).toBe(false);
          });
      });
    });

    describe("PUT /sep12/customer", () => {
      it("accepts customer KYC submission and transitions to PROCESSING", async () => {
        const testAccount = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBR54EB4YAWUEHPLSSH56TM2IB";
        await provider
          .given("Customer profile can be created or updated")
          .uponReceiving("A submission of customer KYC details")
          .withRequest({
            method: "PUT",
            path: "/sep12/customer",
            headers: {
              "Content-Type": "application/json",
            },
            body: {
              account: testAccount,
              first_name: "Jane",
              last_name: "Doe",
              mobile_number: "+254712345678",
            },
          })
          .willRespondWith({
            status: 202,
            headers: JSON_HEADERS,
            body: {
              id: string("cust-123"),
              status: regex("^(ACCEPTED|PROCESSING|NEEDS_INFO|REJECTED)$", "PROCESSING"),
            },
          })
          .executeTest(async (mockServer) => {
            const res = await axios.put(
              `${mockServer.url}/sep12/customer`,
              {
                account: testAccount,
                first_name: "Jane",
                last_name: "Doe",
                mobile_number: "+254712345678",
              },
              {
                headers: { "Content-Type": "application/json" },
              },
            );

            expect(res.status).toBe(202);
            expect(res.data.id).toBe("cust-123");
            expect(res.data.status).toBe("PROCESSING");
          });
      });
    });
  });
});

