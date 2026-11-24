import express from "express";
import request from "supertest";
import {
  ORANGE_MERCHANT_ACCOUNT_GUID,
  OrangeQrCodeGenerator,
  OrangeQrPaymentListener,
  appendCrc,
  buildOrangeMoneyQrPayload,
  crc16,
  createOrangeQrRouter,
  encodeTlv,
  renderOrangeMoneyQrSection,
} from "../qrCode";
import {
  SEP24_INTERACTIVE_HTML,
  renderSep24InteractivePage,
} from "../../../services/sep24InteractivePage";
import { TransactionStatus } from "../../../models/transaction";

describe("EMVCo TLV helpers", () => {
  it("encodes tag, zero-padded length, and value", () => {
    expect(encodeTlv("00", "01")).toBe("000201");
    expect(encodeTlv("59", "Best Transport")).toBe("5914Best Transport");
  });

  it("rejects values longer than 99 characters", () => {
    expect(() => encodeTlv("59", "x".repeat(100))).toThrow(/99 characters/);
  });

  it("computes the CRC-16/CCITT-FALSE check value", () => {
    // Canonical CRC-16/CCITT-FALSE test vector.
    expect(crc16("123456789")).toBe("29B1");
  });

  it("appends tag 63 with the CRC over the whole payload", () => {
    const body = "0002010102";
    const payload = appendCrc(body);
    expect(payload.startsWith(`${body}6304`)).toBe(true);
    expect(payload.slice(-4)).toBe(crc16(`${body}6304`));
  });
});

describe("buildOrangeMoneyQrPayload", () => {
  const baseOptions = {
    merchantId: "MERCHANT-42",
    amount: 1250,
    currency: "KES",
    reference: "INV-001",
    merchantName: "Mama Mboga",
    merchantCity: "Nairobi",
  };

  it("encodes merchant id, amount, currency and reference", () => {
    const payload = buildOrangeMoneyQrPayload(baseOptions);

    // Merchant account template (tag 26) carries GUID + merchant id + reference
    expect(payload).toContain(`00${String(ORANGE_MERCHANT_ACCOUNT_GUID.length).padStart(2, "0")}${ORANGE_MERCHANT_ACCOUNT_GUID}`);
    expect(payload).toContain("MERCHANT-42");
    expect(payload).toContain("INV-001");
    // ISO 4217 numeric currency for KES is 404
    expect(payload).toContain("5303404");
    // Amount formatted to two decimals
    expect(payload).toContain("54071250.00");
    // Dynamic QR marker
    expect(payload).toContain("010212");
    // Country code derived from currency
    expect(payload).toContain("5802KE");
    // Merchant name / city
    expect(payload).toContain("Mama Mboga");
    expect(payload).toContain("Nairobi");
  });

  it("produces a valid trailing CRC", () => {
    const payload = buildOrangeMoneyQrPayload(baseOptions);
    const crc = payload.slice(-4);
    expect(crc).toBe(crc16(payload.slice(0, -4)));
  });

  it("emits a static QR when no amount is provided", () => {
    const payload = buildOrangeMoneyQrPayload({
      merchantId: "M1",
      amount: 0,
      currency: "XOF",
    });
    expect(payload).toContain("010211");
    expect(payload).not.toContain("54");
  });

  it("supports the major Orange Money corridors", () => {
    for (const [currency, numeric] of [
      ["XOF", "952"],
      ["XAF", "950"],
      ["NGN", "566"],
      ["MAD", "504"],
    ]) {
      const payload = buildOrangeMoneyQrPayload({
        merchantId: "M1",
        amount: 10,
        currency,
      });
      expect(payload).toContain(`5303${numeric}`);
    }
  });

  it("rejects a missing merchant id and unsupported currency", () => {
    expect(() =>
      buildOrangeMoneyQrPayload({ merchantId: "", amount: 1 }),
    ).toThrow(/merchantId/);
    expect(() =>
      buildOrangeMoneyQrPayload({
        merchantId: "M1",
        amount: 1,
        currency: "XYZ",
      }),
    ).toThrow(/Unsupported Orange Money currency/);
  });
});

describe("OrangeQrCodeGenerator", () => {
  const generator = new OrangeQrCodeGenerator();

  it("generates an Orange Money QR code with a base64 data URL", async () => {
    const qr = await generator.generate({
      merchantId: "MERCHANT-42",
      amount: 1250,
      currency: "KES",
      reference: "INV-001",
    });

    expect(qr.payload).toContain("MERCHANT-42");
    expect(qr.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(qr.dataUrl.length).toBeGreaterThan(100);
    expect(qr.amount).toBe("1250.00");
    expect(qr.currency).toBe("KES");
  });

  it("returns raw base64 and a PNG buffer", async () => {
    const qr = await generator.generate({
      merchantId: "M1",
      amount: 10,
      currency: "NGN",
    });

    const base64 = await generator.generatePngBase64(qr.payload);
    expect(base64.startsWith("data:image")).toBe(false);
    expect(() => Buffer.from(base64, "base64")).not.toThrow();

    const buffer = await generator.generateBuffer(qr.payload);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // PNG magic number
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe("renderOrangeMoneyQrSection", () => {
  it("embeds the base64 image and escapes untrusted values", () => {
    const html = renderOrangeMoneyQrSection({
      dataUrl: "data:image/png;base64,AAA",
      merchantId: "<script>bad</script>",
      amount: "10.00",
      currency: "KES",
      reference: "INV-001",
    });

    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("INV-001");
  });
});

describe("renderSep24InteractivePage", () => {
  it("returns the base page unchanged when nothing is injected", () => {
    expect(renderSep24InteractivePage()).toBe(SEP24_INTERACTIVE_HTML);
  });

  it("injects the QR section before the closing body tag", () => {
    const html = renderSep24InteractivePage({
      qrSectionHtml: "<section id=\"orange-money-qr\">QR</section>",
    });

    expect(html).toContain('id="orange-money-qr"');
    expect(html.indexOf('id="orange-money-qr"')).toBeLessThan(
      html.lastIndexOf("</body>"),
    );
    expect(html.startsWith(SEP24_INTERACTIVE_HTML.slice(0, 100))).toBe(true);
  });
});

describe("OrangeQrPaymentListener", () => {
  function buildListener(transaction: any = { id: "txn-1", userId: "user-1" }) {
    const findById = jest.fn().mockResolvedValue(transaction);
    const updateStatus = jest.fn().mockResolvedValue(true);
    const notifyUser = jest.fn();

    const listener = new OrangeQrPaymentListener({
      transactionModel: { findById, updateStatus },
      notifyUser,
    });

    return { listener, findById, updateStatus, notifyUser };
  }

  it("marks the transaction completed on a successful wallet payment", async () => {
    const { listener, updateStatus, notifyUser } = buildListener();

    const result = await listener.handleConfirmation({
      merchantId: "MERCHANT-42",
      amount: 1250,
      reference: "txn-1",
      status: "success",
      providerTransactionId: "OM-999",
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("success");
    expect(updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Completed,
      "user-1",
    );
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "txn-1", status: "success" }),
    );
  });

  it("maps a failed wallet payment to a failed transaction", async () => {
    const { listener, updateStatus } = buildListener();
    const result = await listener.handleConfirmation({
      merchantId: "MERCHANT-42",
      amount: 10,
      reference: "txn-1",
      status: "failed",
    });

    expect(result.status).toBe("failed");
    expect(updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Failed,
      "user-1",
    );
  });

  it("rejects invalid payloads", async () => {
    const { listener } = buildListener();
    await expect(
      listener.handleConfirmation({ merchantId: "", amount: 10, status: "success" }),
    ).resolves.toMatchObject({ accepted: false });
    await expect(
      listener.handleConfirmation({ merchantId: "M1", amount: 0, status: "success" }),
    ).resolves.toMatchObject({ accepted: false, message: "Invalid amount" });
    await expect(
      listener.handleConfirmation({ merchantId: "M1", amount: 5, status: "success" }),
    ).resolves.toMatchObject({ accepted: false, message: "Missing transaction reference" });
  });

  it("reports an unknown transaction", async () => {
    const { listener } = buildListener(null);
    const result = await listener.handleConfirmation({
      merchantId: "M1",
      amount: 5,
      reference: "missing",
      status: "success",
    });
    expect(result).toMatchObject({ accepted: false, status: "not_found" });
  });
});

describe("Orange Money QR router", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/orange/qr",
      createOrangeQrRouter({ listener: new OrangeQrPaymentListener({
        transactionModel: {
          findById: jest.fn().mockResolvedValue({ id: "txn-1", userId: "u1" }),
          updateStatus: jest.fn().mockResolvedValue(true),
        },
      }) }),
    );
    return app;
  }

  it("returns a payload for the requested merchant and amount", async () => {
    const res = await request(buildApp()).get(
      "/api/orange/qr/payload?merchant_id=M1&amount=10&currency=KES",
    );
    expect(res.status).toBe(200);
    expect(res.body.payload).toContain("M1");
  });

  it("returns a PNG QR image", async () => {
    const res = await request(buildApp()).get(
      "/api/orange/qr/image?merchant_id=M1&amount=10&currency=KES",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });

  it("accepts wallet payment webhooks", async () => {
    const res = await request(buildApp())
      .post("/api/orange/qr/webhook")
      .send({ merchantId: "M1", amount: 10, reference: "txn-1", status: "success" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, status: "success" });
  });
});
