import { Router, Request, Response } from "express";

export const devSimulatorRouter = Router();

const SIMULATOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transaction Webhook Simulator</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #333; background: #f9fafb; }
        .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        h1 { margin-top: 0; color: #111827; }
        .form-group { margin-bottom: 1.5rem; }
        label { display: block; font-weight: 500; margin-bottom: 0.5rem; color: #374151; }
        input[type="text"], select, textarea { width: 100%; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 4px; box-sizing: border-box; font-family: monospace; font-size: 14px; }
        textarea { height: 280px; resize: vertical; }
        button { background: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 500; border-radius: 4px; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #1d4ed8; }
        button:disabled { background: #93c5fd; cursor: not-allowed; }
        .response-container { margin-top: 2rem; }
        pre { background: #1f2937; color: #e5e7eb; padding: 1rem; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
        .badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 600; margin-bottom: 1rem; }
        .badge-dev { background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; }
    </style>
</head>
<body>
    <div class="card">
        <span class="badge badge-dev">Development Only</span>
        <h1>Transaction Webhook Simulator</h1>
        <p>Manually trigger provider callback events to test your local webhook handlers.</p>

        <div class="form-group">
            <label for="endpoint">Webhook Endpoint URL</label>
            <input type="text" id="endpoint" value="/webhooks/momo" />
        </div>

        <div class="form-group">
            <label for="template">Payload Template</label>
            <select id="template" onchange="loadTemplate()">
                <option value="momo_success">Momo API - Success</option>
                <option value="momo_failed">Momo API - Failed (Insufficient Funds)</option>
                <option value="momo_pending">Momo API - Pending</option>
                <option value="airtel_success">Airtel - Success</option>
                <option value="airtel_failed">Airtel - Failed</option>
            </select>
        </div>

        <div class="form-group">
            <label for="payload">JSON Payload</label>
            <textarea id="payload"></textarea>
        </div>

        <button onclick="sendWebhook()" id="sendBtn">Trigger Webhook</button>

        <div class="response-container">
            <label>Server Response</label>
            <pre id="response">Awaiting request...</pre>
        </div>
    </div>

    <script>
        const templates = {
            momo_success: {
                "financialTransactionId": "8523" + Math.floor(Math.random() * 1000000),
                "externalId": "TXN-YYYYMMDD-XXXXX",
                "amount": "1500",
                "currency": "XAF",
                "payer": {
                    "partyIdType": "MSISDN",
                    "partyId": "237670000000"
                },
                "payerMessage": "Payment for order",
                "payeeNote": "Payment received",
                "status": "SUCCESSFUL"
            },
            momo_failed: {
                "financialTransactionId": "8523" + Math.floor(Math.random() * 1000000),
                "externalId": "TXN-YYYYMMDD-XXXXX",
                "status": "FAILED",
                "reason": {
                    "code": "NOT_ENOUGH_FUNDS",
                    "message": "The payer does not have enough funds"
                }
            },
            momo_pending: {
                "externalId": "TXN-YYYYMMDD-XXXXX",
                "status": "PENDING"
            },
            airtel_success: {
                "transaction": {
                    "id": "AIRTEL" + Math.floor(Math.random() * 1000000),
                    "message": "Success",
                    "status_code": "TS",
                    "airtel_money_id": "MP230809.1500.H45678"
                },
                "reference": "TXN-YYYYMMDD-XXXXX"
            },
            airtel_failed: {
                "transaction": {
                    "id": "AIRTEL" + Math.floor(Math.random() * 1000000),
                    "message": "Failed due to insufficient balance",
                    "status_code": "TF"
                },
                "reference": "TXN-YYYYMMDD-XXXXX"
            }
        };

        function loadTemplate() {
            const val = document.getElementById('template').value;
            const payload = templates[val];
            
            // Try to inject a real-looking dynamic timestamp into the templates for uniqueness
            const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, '');
            const refNumber = \`TXN-\${dateStr}-\${Math.floor(10000 + Math.random() * 90000)}\`;
            
            if (payload.externalId) payload.externalId = refNumber;
            if (payload.reference) payload.reference = refNumber;
            
            document.getElementById('payload').value = JSON.stringify(payload, null, 4);
        }

        async function sendWebhook() {
            const endpoint = document.getElementById('endpoint').value;
            const payloadStr = document.getElementById('payload').value;
            const responseEl = document.getElementById('response');
            const btn = document.getElementById('sendBtn');
            
            try {
                const payload = JSON.parse(payloadStr);
                btn.disabled = true;
                btn.textContent = "Sending...";
                responseEl.textContent = "Sending POST request to " + endpoint + "...";
                
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const text = await res.text();
                const statusLine = \`HTTP \${res.status} \${res.statusText}\\n\\n\`;
                
                responseEl.textContent = statusLine + text;
                responseEl.style.color = res.ok ? '#4ade80' : '#f87171';
            } catch (err) {
                responseEl.textContent = "Error: " + err.message;
                responseEl.style.color = '#f87171';
            } finally {
                btn.disabled = false;
                btn.textContent = "Trigger Webhook";
            }
        }

        // Initialize on load
        loadTemplate();
    </script>
</body>
</html>`;

devSimulatorRouter.get("/simulator", (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res
      .status(403)
      .json({
        error:
          "Simulator is explicitly disabled in the production environment.",
      });
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.send(SIMULATOR_HTML);
});
