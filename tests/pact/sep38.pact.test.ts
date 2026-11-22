/**
 * Pact Consumer Contract Tests — SEP-38 price quotation API
 *
 * Defines the contract between SEP-38 consumers (wallets / anchors integrating
 * with the mobile money bridge) and the bridge's /sep38 endpoints:
 *   - GET /sep38/prices      indicative prices for every supported buy asset
 *   - GET /sep38/price       indicative price (+ fees) for one asset pair
 *   - GET /sep38/quote/:id   firm quote carrying the expiration timestamp
 *
 * Matchers are schema-based (type / regex), so the contract pins field names,
 * types and formats rather than live exchange-rate values.
 */
import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import axios from "axios";

const { like, regex, eachLike, integer, string } = MatchersV3;

const provider = new PactV3({
  consumer: "Sep38Consumer",
  provider: "MobileMoneyBridge",
  dir: path.resolve(__dirname, "../../pacts"),
  logLevel: "warn",
});

const DECIMAL_STRING = "^\\d+(\\.\\d+)?$";
const ASSET_ID = "^(stellar|iso4217):[A-Za-z0-9:_-]+$";
const ISO8601_UTC = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$";

const decimalString = (example: string) => regex(DECIMAL_STRING, example);
const assetId = (example: string) => regex(ASSET_ID, example);
const timestamp = (example: string) => regex(ISO8601_UTC, example);

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

describe("SEP-38 Price Quotation Contract", () => {
  describe("GET /sep38/prices", () => {
    it("returns an indicative price for every supported buy asset", async () => {
      await provider
        .given("Indicative rates are available for iso4217:USD")
        .uponReceiving("A request for prices selling 100 USD")
        .withRequest({
          method: "GET",
          path: "/sep38/prices",
          query: { sell_asset: "iso4217:USD", sell_amount: "100" },
        })
        .willRespondWith({
          status: 200,
          headers: JSON_HEADERS,
          body: {
            buy_assets: eachLike({
              asset: assetId("iso4217:KES"),
              price: decimalString("129.5000000"),
              decimals: integer(7),
            }),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/prices`, {
            params: { sell_asset: "iso4217:USD", sell_amount: "100" },
          });
          expect(res.status).toBe(200);
          expect(res.data.buy_assets.length).toBeGreaterThan(0);
          for (const item of res.data.buy_assets) {
            expect(item.asset).toMatch(new RegExp(ASSET_ID));
            expect(item.price).toMatch(new RegExp(DECIMAL_STRING));
            expect(Number.isInteger(item.decimals)).toBe(true);
          }
        });
    });

    it("narrows the result to a single buy_asset when requested", async () => {
      await provider
        .given("Indicative rates are available for iso4217:USD")
        .uponReceiving("A request for the USD to NGN price only")
        .withRequest({
          method: "GET",
          path: "/sep38/prices",
          query: {
            sell_asset: "iso4217:USD",
            sell_amount: "50",
            buy_asset: "iso4217:NGN",
          },
        })
        .willRespondWith({
          status: 200,
          headers: JSON_HEADERS,
          body: {
            buy_assets: [
              {
                asset: string("iso4217:NGN"),
                price: decimalString("1550.0000000"),
                decimals: integer(7),
              },
            ],
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/prices`, {
            params: {
              sell_asset: "iso4217:USD",
              sell_amount: "50",
              buy_asset: "iso4217:NGN",
            },
          });
          expect(res.status).toBe(200);
          expect(res.data.buy_assets).toHaveLength(1);
          expect(res.data.buy_assets[0].asset).toBe("iso4217:NGN");
        });
    });

    it("rejects a request without sell_amount", async () => {
      await provider
        .uponReceiving("A prices request missing sell_amount")
        .withRequest({
          method: "GET",
          path: "/sep38/prices",
          query: { sell_asset: "iso4217:USD" },
        })
        .willRespondWith({
          status: 400,
          headers: JSON_HEADERS,
          body: { error: like("Missing required parameter: sell_amount") },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/prices`, {
            params: { sell_asset: "iso4217:USD" },
            validateStatus: () => true,
          });
          expect(res.status).toBe(400);
          expect(typeof res.data.error).toBe("string");
        });
    });
  });

  describe("GET /sep38/price", () => {
    it("returns the exchange rate and fee breakdown for a supported pair", async () => {
      await provider
        .given("Indicative rates are available for iso4217:USD")
        .uponReceiving("A request for the USD to KES indicative price")
        .withRequest({
          method: "GET",
          path: "/sep38/price",
          query: { sell_asset: "iso4217:USD", buy_asset: "iso4217:KES" },
        })
        .willRespondWith({
          status: 200,
          headers: JSON_HEADERS,
          body: {
            sell_asset: string("iso4217:USD"),
            buy_asset: string("iso4217:KES"),
            price: decimalString("129.5000000"),
            fee_percent: decimalString("1.5"),
            fee_fixed: decimalString("0.0000000"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/price`, {
            params: { sell_asset: "iso4217:USD", buy_asset: "iso4217:KES" },
          });
          expect(res.status).toBe(200);
          expect(res.data.sell_asset).toBe("iso4217:USD");
          expect(res.data.buy_asset).toBe("iso4217:KES");
          expect(res.data.price).toMatch(new RegExp(DECIMAL_STRING));
          expect(res.data.fee_percent).toMatch(new RegExp(DECIMAL_STRING));
          expect(res.data.fee_fixed).toMatch(new RegExp(DECIMAL_STRING));
        });
    });

    it("supports Stellar asset definitions as the sell asset", async () => {
      await provider
        .given("Indicative rates are available for stellar:XLM")
        .uponReceiving("A request for the XLM to USD indicative price")
        .withRequest({
          method: "GET",
          path: "/sep38/price",
          query: { sell_asset: "stellar:XLM", buy_asset: "iso4217:USD" },
        })
        .willRespondWith({
          status: 200,
          headers: JSON_HEADERS,
          body: {
            sell_asset: string("stellar:XLM"),
            buy_asset: string("iso4217:USD"),
            price: decimalString("0.1200000"),
            fee_percent: decimalString("1.5"),
            fee_fixed: decimalString("0.0000000"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/price`, {
            params: { sell_asset: "stellar:XLM", buy_asset: "iso4217:USD" },
          });
          expect(res.status).toBe(200);
          expect(res.data.sell_asset).toBe("stellar:XLM");
          expect(res.data.price).toMatch(new RegExp(DECIMAL_STRING));
        });
    });

    it("rejects an unsupported asset pair", async () => {
      await provider
        .uponReceiving("A price request for an unsupported asset pair")
        .withRequest({
          method: "GET",
          path: "/sep38/price",
          query: { sell_asset: "iso4217:ZZZ", buy_asset: "iso4217:USD" },
        })
        .willRespondWith({
          status: 400,
          headers: JSON_HEADERS,
          body: { error: like("Unsupported asset pair") },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/price`, {
            params: { sell_asset: "iso4217:ZZZ", buy_asset: "iso4217:USD" },
            validateStatus: () => true,
          });
          expect(res.status).toBe(400);
          expect(typeof res.data.error).toBe("string");
        });
    });

    it("reports insufficient liquidity when no rate can be resolved", async () => {
      await provider
        .given("No liquidity is available for iso4217:USD to iso4217:KES")
        .uponReceiving("A price request that cannot be priced")
        .withRequest({
          method: "GET",
          path: "/sep38/price",
          query: { sell_asset: "iso4217:USD", buy_asset: "iso4217:KES" },
        })
        .willRespondWith({
          status: 503,
          headers: JSON_HEADERS,
          body: {
            error: like("Insufficient liquidity for the requested asset pair"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/sep38/price`, {
            params: { sell_asset: "iso4217:USD", buy_asset: "iso4217:KES" },
            validateStatus: () => true,
          });
          expect(res.status).toBe(503);
        });
    });
  });

  describe("GET /sep38/quote/:id", () => {
    const QUOTE_ID = "b7c2f1e4-8a3d-4c55-9f21-0d6a3e7b1a90";

    it("returns a firm quote with its expiration timestamp", async () => {
      await provider
        .given(`An unexpired quote ${QUOTE_ID} exists`)
        .uponReceiving("A request for an existing quote")
        .withRequest({
          method: "GET",
          path: `/sep38/quote/${QUOTE_ID}`,
        })
        .willRespondWith({
          status: 200,
          headers: JSON_HEADERS,
          body: {
            id: string(QUOTE_ID),
            expires_at: timestamp("2030-01-01T00:01:00.000Z"),
            created_at: timestamp("2030-01-01T00:00:00.000Z"),
            sell_asset: assetId("iso4217:USD"),
            buy_asset: assetId("iso4217:KES"),
            sell_amount: decimalString("100.0000000"),
            buy_amount: decimalString("12950.0000000"),
            price: decimalString("129.5000000"),
            total_price: decimalString("129.5000000"),
            fee_percent: decimalString("1.5"),
            fee_fixed: decimalString("0.0000000"),
            status: string("pending"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/sep38/quote/${QUOTE_ID}`,
          );
          expect(res.status).toBe(200);
          expect(res.data.id).toBe(QUOTE_ID);
          expect(res.data.expires_at).toMatch(new RegExp(ISO8601_UTC));
          expect(new Date(res.data.expires_at).getTime()).toBeGreaterThan(
            new Date(res.data.created_at).getTime(),
          );
          expect(res.data.sell_asset).toMatch(new RegExp(ASSET_ID));
          expect(res.data.buy_asset).toMatch(new RegExp(ASSET_ID));
          expect(res.data.price).toMatch(new RegExp(DECIMAL_STRING));
        });
    });

    it("returns 410 for an expired quote", async () => {
      await provider
        .given(`An expired quote ${QUOTE_ID} exists`)
        .uponReceiving("A request for an expired quote")
        .withRequest({
          method: "GET",
          path: `/sep38/quote/${QUOTE_ID}`,
        })
        .willRespondWith({
          status: 410,
          headers: JSON_HEADERS,
          body: { error: like("Quote has expired") },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/sep38/quote/${QUOTE_ID}`,
            { validateStatus: () => true },
          );
          expect(res.status).toBe(410);
        });
    });

    it("returns 404 for an unknown quote", async () => {
      await provider
        .given("No quote exists with id unknown-quote")
        .uponReceiving("A request for an unknown quote")
        .withRequest({
          method: "GET",
          path: "/sep38/quote/unknown-quote",
        })
        .willRespondWith({
          status: 404,
          headers: JSON_HEADERS,
          body: { error: like("Quote not found") },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/sep38/quote/unknown-quote`,
            { validateStatus: () => true },
          );
          expect(res.status).toBe(404);
        });
    });
  });
});
