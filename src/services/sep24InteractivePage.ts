import { createHash } from "crypto";

export const SEP24_INTERACTIVE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SEP-24 Interactive — Mobile Money</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #f9fafb; line-height: 1.6; }
        .container { max-width: 1120px; margin: 0 auto; padding: 0 1.5rem; }

        .hero-section { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: white; padding: 5rem 0 4rem; text-align: center; }
        .hero-section h1 { font-size: 2.75rem; font-weight: 800; margin-bottom: 1rem; letter-spacing: -0.025em; }
        .hero-section p { font-size: 1.2rem; opacity: 0.9; max-width: 640px; margin: 0 auto 2rem; }
        .hero-section .badge { display: inline-block; background: rgba(255,255,255,0.15); padding: 0.35rem 1rem; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; backdrop-filter: blur(4px); margin-bottom: 1.5rem; }

        .section { padding: 4rem 0; }
        .section-title { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; color: #111827; }
        .section-subtitle { color: #6b7280; margin-bottom: 2.5rem; font-size: 1.05rem; }

        .calculator-section { background: #fff; }
        .calc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; max-width: 560px; margin: 0 auto; }
        .calc-grid label { display: block; font-weight: 600; font-size: 0.875rem; color: #374151; margin-bottom: 0.35rem; }
        .calc-grid input, .calc-grid select { width: 100%; padding: 0.65rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.95rem; }
        .calc-grid .full { grid-column: 1 / -1; }
        .calc-result { grid-column: 1 / -1; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 1rem 1.25rem; text-align: center; }
        .calc-result .amount { font-size: 1.5rem; font-weight: 700; color: #0369a1; }

        .api-section { background: #f3f4f6; }
        .tab-bar { display: flex; gap: 0; margin-bottom: 2rem; border-bottom: 2px solid #e5e7eb; }
        .tab-bar button { padding: 0.75rem 1.5rem; font-size: 0.95rem; font-weight: 600; border: none; background: transparent; color: #6b7280; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.15s; }
        .tab-bar button:hover { color: #374151; }
        .tab-bar button.active { color: #2563eb; border-bottom-color: #2563eb; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .tab-content pre { background: #1f2937; color: #e5e7eb; padding: 1.25rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; white-space: pre-wrap; }
        .tab-content .endpoint { display: inline-block; background: #dbeafe; color: #1e40af; padding: 0.2rem 0.6rem; border-radius: 4px; font-family: monospace; font-size: 0.8rem; font-weight: 600; margin-bottom: 0.75rem; }

        .integration-section { background: #fff; }
        .steps { display: flex; flex-direction: column; gap: 1rem; max-width: 640px; margin: 0 auto; }
        .step { display: flex; gap: 1rem; align-items: flex-start; }
        .step-number { width: 2.25rem; height: 2.25rem; background: #2563eb; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.9rem; flex-shrink: 0; }
        .step-text h3 { font-size: 1rem; font-weight: 600; }
        .step-text p { color: #6b7280; font-size: 0.9rem; }

        .features-section { background: #f9fafb; }
        .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; }
        .feature-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 1.5rem; }
        .feature-card h3 { font-size: 1.05rem; font-weight: 600; margin-bottom: 0.5rem; }
        .feature-card p { color: #6b7280; font-size: 0.9rem; }
        .feature-card .icon { font-size: 1.75rem; margin-bottom: 0.75rem; }

        .text-center { text-align: center; }
        .calc-result-label { font-size: 0.85rem; color: #6b7280; }

        .orange-qr-card { display: inline-block; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; }
        .orange-qr-amount { font-size: 1.25rem; font-weight: 700; margin-top: 0.75rem; }
        .orange-qr-merchant { color: #6b7280; font-size: 0.9rem; }

        footer { text-align: center; padding: 2rem 0; color: #9ca3af; font-size: 0.85rem; border-top: 1px solid #e5e7eb; }
    </style>
</head>
<body>
    <section class="hero-section">
        <div class="container">
            <div class="badge">Stellar Ecosystem Proposal 24</div>
            <h1>Interactive Deposit &amp; Withdrawal</h1>
            <p>Enable your users to deposit and withdraw assets directly through a seamless interactive web view powered by SEP-24.</p>
        </div>
    </section>

    <section class="section calculator-section">
        <div class="container text-center">
            <h2 class="section-title">Fee Calculator</h2>
            <p class="section-subtitle">Estimate transaction fees before you initiate a transfer.</p>
            <div class="calc-grid">
                <div>
                    <label for="calc-amount">Amount</label>
                    <input type="number" id="calc-amount" value="1000" />
                </div>
                <div>
                    <label for="calc-asset">Asset</label>
                    <select id="calc-asset">
                        <option value="USDC">USDC</option>
                        <option value="XLM">XLM</option>
                    </select>
                </div>
                <div>
                    <label for="calc-operation">Operation</label>
                    <select id="calc-operation">
                        <option value="deposit">Deposit</option>
                        <option value="withdraw">Withdraw</option>
                    </select>
                </div>
                <div class="calc-result">
                    <p class="calc-result-label">Estimated Fee</p>
                    <p class="amount">2.50 USDC</p>
                </div>
            </div>
        </div>
    </section>

    <section class="section api-section">
        <div class="container">
            <h2 class="section-title">API Explorer</h2>
            <p class="section-subtitle">Explore the SEP-24 endpoints for deposit and withdrawal flows.</p>
            <div class="tab-bar">
                <button id="tab-btn-deposit" class="active">Deposit</button>
                <button id="tab-btn-withdraw">Withdraw</button>
            </div>
            <div id="tab-deposit" class="tab-content active">
                <span class="endpoint">POST /sep24/deposit</span>
                <pre>{
  "asset_code": "USDC",
  "amount": "100.00",
  "account": "GABCD...1234"
}</pre>
            </div>
            <div id="tab-withdraw" class="tab-content">
                <span class="endpoint">POST /sep24/withdraw</span>
                <pre>{
  "asset_code": "USDC",
  "amount": "50.00",
  "account": "GABCD...1234"
}</pre>
            </div>
        </div>
    </section>

    <section class="section integration-section">
        <div class="container text-center">
            <h2 class="section-title">Integration Steps</h2>
            <p class="section-subtitle">Get up and running in four easy steps.</p>
            <div class="steps">
                <div class="step">
                    <div class="step-number">1</div>
                    <div class="step-text">
                        <h3>Authenticate</h3>
                        <p>Complete SEP-10 web authentication to obtain a shared JWT.</p>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <div class="step-text">
                        <h3>Fetch Info</h3>
                        <p>Call <code>/sep24/info</code> to retrieve supported assets and configuration.</p>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <div class="step-text">
                        <h3>Interactive Flow</h3>
                        <p>POST to <code>/sep24/deposit</code> or <code>/sep24/withdraw</code> to get an interactive URL.</p>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">4</div>
                    <div class="step-text">
                        <h3>Poll for Completion</h3>
                        <p>Monitor transaction status via <code>/sep24/transaction/:id</code> until complete.</p>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <section class="section features-section">
        <div class="container">
            <h2 class="section-title text-center">Features</h2>
            <p class="section-subtitle text-center">Why choose SEP-24 interactive flows.</p>
            <div class="features-grid">
                <div class="feature-card">
                    <div class="icon">🔒</div>
                    <h3>Secure</h3>
                    <p>HMAC-signed URLs ensure that only authorized wallets can complete transactions.</p>
                </div>
                <div class="feature-card">
                    <div class="icon">⚡</div>
                    <h3>Fast</h3>
                    <p>Low-latency interactive flows with real-time status updates via polling.</p>
                </div>
                <div class="feature-card">
                    <div class="icon">🌐</div>
                    <h3>Multi-Asset</h3>
                    <p>Support for USDC, XLM, and custom Stellar assets with automatic fee calculation.</p>
                </div>
                <div class="feature-card">
                    <div class="icon">📱</div>
                    <h3>Mobile-Friendly</h3>
                    <p>Responsive web views that work seamlessly on any device or wallet.</p>
                </div>
            </div>
        </div>
    </section>

    <footer>
        <div class="container">Mobile Money &mdash; SEP-24 Interactive View</div>
    </footer>

    <script>
        (function() {
            var depositBtn = document.getElementById('tab-btn-deposit');
            var withdrawBtn = document.getElementById('tab-btn-withdraw');
            var depositTab = document.getElementById('tab-deposit');
            var withdrawTab = document.getElementById('tab-withdraw');
            if (depositBtn && withdrawBtn && depositTab && withdrawTab) {
                depositBtn.addEventListener('click', function() {
                    depositBtn.classList.add('active');
                    withdrawBtn.classList.remove('active');
                    depositTab.classList.add('active');
                    withdrawTab.classList.remove('active');
                });
                withdrawBtn.addEventListener('click', function() {
                    withdrawBtn.classList.add('active');
                    depositBtn.classList.remove('active');
                    withdrawTab.classList.add('active');
                    depositTab.classList.remove('active');
                });
            }
        })();
    </script>
</body>
</html>`;

function sha256Source(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

function inlineBlockSources(tag: "script" | "style"): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(SEP24_INTERACTIVE_HTML.matchAll(pattern), (match) =>
    sha256Source(match[1]),
  );
}

/**
 * CSP hash sources for the inline `<script>` and `<style>` blocks above, so
 * the interactive view can run under a strict policy without
 * `'unsafe-inline'`. Computed from the template, so they stay in sync when
 * the markup changes.
 */
export const SEP24_INTERACTIVE_CSP_HASHES = {
  script: inlineBlockSources("script"),
  style: inlineBlockSources("style"),
};

export interface Sep24InteractivePageOptions {
  /**
   * Pre-rendered HTML injected before `</body>`. Used to embed the Orange
   * Money scan-to-pay QR card on the deposit interactive page (#1968).
   */
  qrSectionHtml?: string;
  /** Any additional pre-rendered sections to inject. */
  extraSectionsHtml?: string;
}

/**
 * Render the SEP-24 interactive page, optionally injecting extra sections
 * (for example a provider QR card). Falls back to the exact
 * {@link SEP24_INTERACTIVE_HTML} when nothing is injected so existing
 * consumers are unaffected.
 */
export function renderSep24InteractivePage(
  options: Sep24InteractivePageOptions = {},
): string {
  const injection = [options.extraSectionsHtml, options.qrSectionHtml]
    .filter(Boolean)
    .join("\n");

  if (!injection) return SEP24_INTERACTIVE_HTML;
  return SEP24_INTERACTIVE_HTML.replace("</body>", `${injection}\n</body>`);
}

// ============================================================================
// Expired interactive session notice (#2264)
// ============================================================================

export interface Sep24ExpiredSessionPageOptions {
  /** The expired transaction_id, shown for support/debugging purposes. */
  transactionId: string;
  /**
   * URL the renewal button submits to (a POST endpoint that mints a fresh
   * interactive session for the same deposit/withdrawal and redirects the
   * user to it).
   */
  renewUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders the page shown when a wallet (or user) opens an interactive
 * deposit/withdrawal URL whose session has expired per the configurable
 * `sep24.interactiveSessionExpiryMinutes` duration. Offers a renewal button
 * that posts to `renewUrl` to mint a fresh session rather than leaving the
 * user stuck on a dead link.
 */
export function renderSep24ExpiredSessionPage(
  options: Sep24ExpiredSessionPageOptions,
): string {
  const transactionId = escapeHtml(options.transactionId);
  const renewUrl = escapeHtml(options.renewUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Expired — Mobile Money</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #f9fafb; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); padding: 2.5rem; max-width: 420px; text-align: center; }
        .icon { font-size: 2.5rem; margin-bottom: 1rem; }
        h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 0.5rem; }
        p { color: #6b7280; font-size: 0.95rem; margin-bottom: 1.5rem; }
        .tx-id { font-family: monospace; font-size: 0.8rem; color: #9ca3af; margin-bottom: 1.5rem; word-break: break-all; }
        button { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 0.75rem 1.5rem; font-size: 0.95rem; font-weight: 600; cursor: pointer; width: 100%; }
        button:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">&#9201;</div>
        <h1>This session has expired</h1>
        <p>The interactive deposit/withdrawal link you followed is no longer valid. Start a new session to continue.</p>
        <div class="tx-id">Transaction: ${transactionId}</div>
        <form method="POST" action="${renewUrl}">
            <button type="submit">Renew session</button>
        </form>
    </div>
</body>
</html>`;
}
