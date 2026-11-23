import React, { useState } from "react";

export type TelecomProvider = "MTN" | "Orange" | "M-Pesa";
export type TransactionStatus = "SUCCESS" | "FAILED";
export type TransactionType = "deposit" | "payout";

export interface WebhookSimulatorProps {
  apiBaseUrl?: string;
  defaultTargetUrl?: string;
}

export interface SimulationResponse {
  success: boolean;
  provider: string;
  status: string;
  targetUrl: string;
  payload: Record<string, unknown>;
  signature: string;
  headers: Record<string, string>;
  response: {
    status: number | null;
    statusText?: string;
    latencyMs: number;
    body?: string;
    error?: string;
  };
}

export const WebhookSimulator: React.FC<WebhookSimulatorProps> = ({
  apiBaseUrl = "",
  defaultTargetUrl = "http://localhost:3000/api/webhooks",
}) => {
  const [provider, setProvider] = useState<TelecomProvider>("MTN");
  const [status, setStatus] = useState<TransactionStatus>("SUCCESS");
  const [transactionType, setTransactionType] = useState<TransactionType>("deposit");
  const [targetUrl, setTargetUrl] = useState<string>(defaultTargetUrl);
  const [amount, setAmount] = useState<string>("5000");
  const [currency, setCurrency] = useState<string>("XOF");
  const [secret, setSecret] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleProviderChange = (newProvider: TelecomProvider) => {
    setProvider(newProvider);
    if (newProvider === "M-Pesa") {
      setCurrency("KES");
    } else {
      setCurrency("XOF");
    }
  };

  const handleSimulate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoading(true);
    setErrorMessage(null);
    setResult(null);

    if (!targetUrl.trim()) {
      setErrorMessage("Target URL is required");
      setLoading(false);
      return;
    }

    try {
      const endpoint = `${apiBaseUrl}/api/developer/webhooks/simulate`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          status,
          targetUrl: targetUrl.trim(),
          amount: amount || "1000.00",
          currency,
          transactionType,
          secret: secret.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP error ${res.status}`);
      }

      setResult(data);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to trigger webhook simulation");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="webhook-simulator border rounded-xl p-6 bg-white dark:bg-gray-900 shadow-sm max-w-4xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">
          Interactive Webhook Simulator
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Trigger mock MTN, Orange, and M-Pesa deposit/payout callbacks to your local development
          server (e.g. ngrok or localhost).
        </p>
      </div>

      <form onSubmit={handleSimulate} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="sim-provider"
              className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
            >
              Telecom Provider
            </label>
            <select
              id="sim-provider"
              data-testid="sim-provider"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as TelecomProvider)}
              className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500"
            >
              <option value="MTN">MTN MoMo</option>
              <option value="Orange">Orange Money</option>
              <option value="M-Pesa">M-Pesa</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="sim-status"
              className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
            >
              Transaction Status
            </label>
            <select
              id="sim-status"
              data-testid="sim-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as TransactionStatus)}
              className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500"
            >
              <option value="SUCCESS">SUCCESS (200 Completed)</option>
              <option value="FAILED">FAILED (Rejected / Insufficient Funds)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="sim-type"
              className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
            >
              Flow Type
            </label>
            <select
              id="sim-type"
              data-testid="sim-type"
              value={transactionType}
              onChange={(e) => setTransactionType(e.target.value as TransactionType)}
              className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500"
            >
              <option value="deposit">Deposit (Collection)</option>
              <option value="payout">Payout (Disbursement)</option>
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="sim-target-url"
            className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
          >
            Target Callback URL (localhost / ngrok endpoint)
          </label>
          <input
            id="sim-target-url"
            data-testid="sim-target-url"
            type="url"
            required
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="http://localhost:3000/api/webhooks"
            className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500 font-mono text-sm"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="sim-amount"
              className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
            >
              Amount
            </label>
            <input
              id="sim-amount"
              data-testid="sim-amount"
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor="sim-currency"
              className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
            >
              Currency
            </label>
            <input
              id="sim-currency"
              data-testid="sim-currency"
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500 uppercase"
            />
          </div>

          <div>
            <label
              htmlFor="sim-secret"
              className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-1"
            >
              Webhook Secret (Optional)
            </label>
            <input
              id="sim-secret"
              data-testid="sim-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Defaults to standard secret"
              className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-700 focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <button
          type="submit"
          data-testid="sim-submit-btn"
          disabled={loading}
          className={`w-full py-2.5 px-4 rounded-lg font-medium text-white transition-colors ${
            loading
              ? "bg-blue-400 cursor-not-allowed"
              : "bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:ring-blue-200"
          }`}
        >
          {loading ? "Sending Callback Payload..." : "Send Simulated Webhook"}
        </button>
      </form>

      {errorMessage && (
        <div
          data-testid="sim-error-alert"
          className="mt-4 p-3 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg text-sm border border-red-200 dark:border-red-800"
        >
          <strong>Error:</strong> {errorMessage}
        </div>
      )}

      {result && (
        <div data-testid="sim-results" className="mt-6 space-y-4 border-t pt-4 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-md font-semibold text-gray-900 dark:text-white">
              Delivery Result
            </h3>
            <div className="flex items-center space-x-3">
              <span
                data-testid="sim-status-code"
                className={`px-2.5 py-1 text-xs font-bold rounded-full ${
                  result.response.status && result.response.status >= 200 && result.response.status < 300
                    ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                }`}
              >
                HTTP {result.response.status ?? "Failed"} {result.response.statusText}
              </span>
              <span
                data-testid="sim-latency"
                className="px-2.5 py-1 text-xs font-mono rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              >
                Latency: {result.response.latencyMs} ms
              </span>
            </div>
          </div>

          {result.response.error && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 text-xs rounded border border-amber-200 dark:border-amber-700">
              {result.response.error}
            </div>
          )}

          <div>
            <h4 className="text-xs font-bold uppercase text-gray-500 mb-1">
              HMAC Signature Header
            </h4>
            <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded font-mono text-xs break-all text-gray-800 dark:text-gray-200">
              <code>X-Webhook-Signature: {result.signature}</code>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase text-gray-500 mb-1">
              Sent Callback Payload
            </h4>
            <pre
              data-testid="sim-payload-preview"
              className="p-3 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto font-mono max-h-48"
            >
              {JSON.stringify(result.payload, null, 2)}
            </pre>
          </div>

          {result.response.body && (
            <div>
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-1">
                Endpoint Response Body
              </h4>
              <pre
                data-testid="sim-response-body"
                className="p-3 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-lg text-xs overflow-x-auto font-mono max-h-36 border dark:border-gray-700"
              >
                {result.response.body}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WebhookSimulator;

