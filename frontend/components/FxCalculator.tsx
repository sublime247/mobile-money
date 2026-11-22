import React, { useEffect, useState } from "react";

export type FxCalculatorProps = { pricesUrl?: string; currency: "XAF" | "XOF" | "KES" | "NGN"; bridgeFeePercent?: number; networkFee?: number };
type PriceResponse = { buy_assets?: Array<{ price: string }> };

/** Embeddable USDC calculator backed by the SEP-38 /prices endpoint. */
export function FxCalculator({ pricesUrl = "/sep38/prices", currency, bridgeFeePercent = 0, networkFee = 0 }: FxCalculatorProps) {
  const [amount, setAmount] = useState(""); const [price, setPrice] = useState<number | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { setPrice(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const query = new URLSearchParams({ sell_asset: "stellar:USDC", sell_amount: amount, buy_asset: `iso4217:${currency}` });
        const response = await fetch(`${pricesUrl}?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to fetch rate (${response.status})`);
        const item = ((await response.json()) as PriceResponse).buy_assets?.[0];
        if (!item) throw new Error("No rate available for this currency");
        setPrice(Number(item.price));
      } catch (requestError) { if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : String(requestError)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [amount, currency, pricesUrl]);
  const gross = price === null ? 0 : Number(amount) * price; const bridgeFee = gross * bridgeFeePercent / 100; const received = Math.max(0, gross - bridgeFee - networkFee);
  return <fieldset aria-label="FX calculator"><legend>USDC to {currency}</legend><label>USDC amount <input type="number" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>{loading && <p role="status">Loading live rate…</p>}{error && <p role="alert">{error}</p>}{price !== null && <dl><dt>Rate</dt><dd>{price.toFixed(4)} {currency}/USDC</dd><dt>Network fee</dt><dd>{networkFee.toFixed(2)} {currency}</dd><dt>Bridge fee</dt><dd>{bridgeFee.toFixed(2)} {currency}</dd><dt>Net received</dt><dd>{received.toFixed(2)} {currency}</dd></dl>}</fieldset>;
}
