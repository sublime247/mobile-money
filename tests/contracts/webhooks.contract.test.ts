/**
 * Pact message contracts — provider webhook payloads
 *
 * Our service is the consumer of the webhook events that MTN MoMo, Airtel
 * Money, Orange Money and M-Pesa POST to us. Each test declares the payload
 * shape we depend on, then runs our handler against the generated example
 * message. The resulting pact files (pacts/) can be verified by the provider.
 */
import path from "path";
import {
  MessageConsumerPact,
  MatchersV3,
  asynchronousBodyHandler,
} from "@pact-foundation/pact";
import {
  MpesaProvider,
  MpesaStkCallbackBody,
} from "../../src/services/providers/mpesaService";

const { like, regex, integer } = MatchersV3;

type NormalizedStatus = "completed" | "failed" | "pending";

interface NormalizedWebhook {
  provider: string;
  reference: string;
  status: NormalizedStatus;
}

// Deserializers for the providers that have no shared parser in src/.
function parseMtn(body: any): NormalizedWebhook {
  const map: Record<string, NormalizedStatus> = {
    SUCCESSFUL: "completed",
    FAILED: "failed",
    PENDING: "pending",
  };
  return {
    provider: "mtn",
    reference: body.externalId,
    status: map[body.status],
  };
}

function parseAirtel(body: any): NormalizedWebhook {
  const map: Record<string, NormalizedStatus> = {
    TS: "completed",
    TF: "failed",
    TIP: "pending",
  };
  return {
    provider: "airtel",
    reference: body.transaction.id,
    status: map[body.transaction.status_code],
  };
}

function parseOrange(body: any): NormalizedWebhook {
  const map: Record<string, NormalizedStatus> = {
    SUCCESSFUL: "completed",
    FAILED: "failed",
    PENDING: "pending",
    IN_PROGRESS: "pending",
  };
  return {
    provider: "orange",
    reference: body.reference,
    status: map[body.status],
  };
}

const pactDir = path.resolve(__dirname, "../../pacts");

function consumerFor(provider: string) {
  return new MessageConsumerPact({
    consumer: "MobileMoneyService",
    provider,
    dir: pactDir,
    logLevel: "warn",
  });
}

describe("Provider webhook contracts", () => {
  it("MTN MoMo: collection callback with a terminal status", async () => {
    await consumerFor("MTNWebhook")
      .given("a collection request has completed")
      .expectsToReceive("an MTN collection callback")
      .withContent({
        financialTransactionId: like("363440463"),
        externalId: like("MTN-1700000000000"),
        amount: like("100"),
        currency: like("EUR"),
        payer: { partyIdType: "MSISDN", partyId: like("46733123450") },
        status: regex("^(SUCCESSFUL|FAILED|PENDING)$", "SUCCESSFUL"),
      })
      .verify(
        asynchronousBodyHandler(async (body: any) => {
          const event = parseMtn(body);
          expect(event.reference).toBe("MTN-1700000000000");
          expect(event.status).toBe("completed");
        }),
      );
  });

  it("Airtel Money: transaction callback with status code", async () => {
    await consumerFor("AirtelWebhook")
      .given("a payment has completed")
      .expectsToReceive("an Airtel transaction callback")
      .withContent({
        transaction: {
          id: like("AIRTEL-1700000000000"),
          message: like("Paid successfully"),
          status_code: regex("^(TS|TF|TIP)$", "TS"),
          airtel_money_id: like("MP210603.1234.L06941"),
        },
      })
      .verify(
        asynchronousBodyHandler(async (body: any) => {
          const event = parseAirtel(body);
          expect(event.reference).toBe("AIRTEL-1700000000000");
          expect(event.status).toBe("completed");
        }),
      );
  });

  it("Orange Money: callback with reference and status", async () => {
    await consumerFor("OrangeWebhook")
      .given("a payment has failed")
      .expectsToReceive("an Orange Money callback")
      .withContent({
        reference: like("ORANGE-1700000000000"),
        status: regex("^(SUCCESSFUL|FAILED|PENDING|IN_PROGRESS)$", "FAILED"),
        transactionId: like("OM-123"),
        failureReason: like("Insufficient funds"),
      })
      .verify(
        asynchronousBodyHandler(async (body: any) => {
          const event = parseOrange(body);
          expect(event.reference).toBe("ORANGE-1700000000000");
          expect(event.status).toBe("failed");
        }),
      );
  });

  it("M-Pesa: STK push callback is parsed by MpesaProvider", async () => {
    await consumerFor("MpesaWebhook")
      .given("an STK push has been paid")
      .expectsToReceive("an M-Pesa STK callback")
      .withContent({
        Body: {
          stkCallback: {
            MerchantRequestID: like("29115-34620561-1"),
            CheckoutRequestID: like("ws_CO_191220191020363925"),
            ResultCode: integer(0),
            ResultDesc: like("The service request is processed successfully."),
            CallbackMetadata: {
              Item: [
                { Name: "Amount", Value: like(1) },
                { Name: "MpesaReceiptNumber", Value: like("NLJ7RT61SV") },
                { Name: "PhoneNumber", Value: like(254708374149) },
              ],
            },
          },
        },
      })
      .verify(
        asynchronousBodyHandler(async (body: any) => {
          const result = MpesaProvider.processStkCallback(
            body as MpesaStkCallbackBody,
          );
          expect(result.success).toBe(true);
          expect(result.checkoutRequestId).toBe("ws_CO_191220191020363925");
          expect(result.mpesaReceiptNumber).toBe("NLJ7RT61SV");
          expect(result.amount).toBe(1);
        }),
      );
  });
});
