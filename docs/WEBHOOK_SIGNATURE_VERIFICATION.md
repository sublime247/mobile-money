# Merchant Webhook Signature Verification & Replay Defense

When Mobile Money delivers status updates to your configured webhook endpoint, each HTTP POST request is signed using HMAC-SHA256 with your shared merchant webhook secret. This guarantees payload authenticity and integrity, and defends against replay attacks.

---

## Headers Included

Every outgoing webhook request includes the following headers:

| Header | Description | Example |
| :--- | :--- | :--- |
| `X-Signature` | HMAC-SHA256 signature prefixed with `sha256=` | `sha256=a1b2c3d4e5f6...` |
| `X-Signature-Timestamp` | Unix epoch timestamp (seconds) when the payload was signed | `1773000000` |
| `Content-Type` | MIME type of request body | `application/json` |

> [!IMPORTANT]
> **5-Minute Tolerance Window**: Always verify that the timestamp in `X-Signature-Timestamp` is within **300 seconds (5 minutes)** of your server's current time. Reject any request whose timestamp falls outside this window to defend against replay attacks.

---

## Signature Calculation

The signature is computed as:

$$\text{signature} = \text{HEX}\Big(\text{HMAC-SHA256}\big(\text{secret},\; \text{timestamp} + \text{"."} + \text{raw\_body}\big)\Big)$$

The header value sent in `X-Signature` is:
```http
X-Signature: sha256=<hex_digest>
```

---

## Verification Implementation

### TypeScript / Node.js

```typescript
import { createHmac, timingSafeEqual } from "crypto";

const TOLERANCE_SECONDS = 300; // 5 minutes

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  timestampHeader: string,
  webhookSecret: string
): boolean {
  if (!signatureHeader || !timestampHeader || !webhookSecret) {
    return false;
  }

  // Extract hex digest if prefixed with sha256=
  const signatureHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  // Validate format
  if (!/^\d+$/.test(timestampHeader) || !/^[0-9a-f]{64}$/i.test(signatureHex)) {
    return false;
  }

  // Prevent replay attacks by enforcing 5-minute tolerance window
  const timestamp = Number(timestampHeader);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }

  // Recompute expected signature
  const expectedHex = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const actualBuffer = Buffer.from(signatureHex, "hex");

  // Constant-time comparison prevents timing attacks
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}
```

### Express.js Middleware Example

```typescript
import express, { Request, Response } from "express";
import { verifyWebhook } from "./verifyWebhook";

const app = express();

// Ensure raw body is preserved for signature verification
app.post(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  (req: Request, res: Response) => {
    const rawBody = req.body.toString("utf8");
    const signature = req.headers["x-signature"] as string;
    const timestamp = req.headers["x-signature-timestamp"] as string;
    const secret = process.env.MERCHANT_WEBHOOK_SECRET!;

    const isValid = verifyWebhook(rawBody, signature, timestamp, secret);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid webhook signature or expired timestamp" });
    }

    const payload = JSON.parse(rawBody);
    console.log("Received verified event:", payload.event_type);

    return res.status(200).json({ received: true });
  }
);
```

### Python (FastAPI / Flask)

```python
import hmac
import hashlib
import time

TOLERANCE_SECONDS = 300  # 5 minutes

def verify_webhook(raw_body: bytes, signature_header: str, timestamp_header: str, secret: str) -> bool:
    if not signature_header or not timestamp_header:
        return False

    if signature_header.startswith("sha256="):
        signature_header = signature_header[7:]

    try:
        timestamp = int(timestamp_header)
    except ValueError:
        return False

    # Check 5-minute window
    if abs(time.time() - timestamp) > TOLERANCE_SECONDS:
        return False

    # Compute expected signature
    signed_payload = f"{timestamp}.".encode("utf-8") + raw_body
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()

    return hmac.compare_digest(expected.lower(), signature_header.lower())
```

---

## SDK Integration

If you use the official `@stellar-bridge/sdk`, the verification helper is built in:

```typescript
import { verifyWebhookSignature } from "@stellar-bridge/sdk";

const isValid = verifyWebhookSignature(
  rawBody,
  req.headers["x-signature"],
  req.headers["x-signature-timestamp"],
  process.env.MERCHANT_WEBHOOK_SECRET
);
```
