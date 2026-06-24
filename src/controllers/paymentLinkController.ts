import { Request, Response } from "express";
import crypto from "crypto";
import { PaymentLinkModel } from "../models/paymentLink";
import { TransactionModel, TransactionStatus } from "../models/transaction";

const paymentLinkModel = new PaymentLinkModel();
const transactionModel = new TransactionModel();

async function addTransactionJob(data: any, options?: any) {
  const queue = require("../queue/transactionQueue.js");
  return queue.addTransactionJob(data, options);
}

/**
 * Endpoint for merchants to create a new secure payment link.
 * POST /api/payment-links
 */
export async function createPaymentLinkHandler(
  req: Request,
  res: Response,
): Promise<Response> {
  try {
    const {
      amount,
      currency = "XAF",
      description,
      isOneTime = true,
      stellarAddress,
      redirectSuccessUrl,
      redirectFailUrl,
      expiresIn, // in seconds
    } = req.body;

    // Validate inputs
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res
        .status(400)
        .json({ error: "Amount must be a positive number" });
    }

    if (!stellarAddress || !/^G[A-Z2-7]{55}$/.test(stellarAddress)) {
      return res
        .status(400)
        .json({
          error:
            "A valid target Stellar public key (stellarAddress) is required",
        });
    }

    // Get active merchant ID from the authenticated session
    const merchantId = (req as any).user?.id || req.body.merchantId;
    if (!merchantId) {
      return res.status(401).json({ error: "Merchant ID not authenticated" });
    }

    // Generate unique random token
    const token = crypto.randomBytes(16).toString("hex");

    const expiresAt = expiresIn
      ? new Date(Date.now() + Number(expiresIn) * 1000)
      : undefined;

    const link = await paymentLinkModel.create({
      merchantId,
      amount: String(parsedAmount),
      currency,
      description,
      token,
      isOneTime: Boolean(isOneTime),
      stellarAddress,
      redirectSuccessUrl,
      redirectFailUrl,
      expiresAt,
    });

    const protocol = req.protocol;
    const host = req.get("host") || "";
    const paymentUrl = `${protocol}://${host}/pay/${token}`;

    return res.status(201).json({
      message: "Payment link created successfully",
      paymentLink: link,
      paymentUrl,
    });
  } catch (error) {
    console.error("Failed to create payment link:", error);
    return res.status(500).json({ error: "Failed to create payment link" });
  }
}

/**
 * Public endpoint to render the secure payment landing page.
 * GET /pay/:token
 */
export async function renderPaymentLinkLandingHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { token } = req.params;
    const link = await paymentLinkModel.findByToken(token);

    if (!link) {
      return renderStaticErrorPage(
        res,
        "This payment link is invalid or does not exist.",
      );
    }

    // Validate expiration
    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      return renderStaticErrorPage(res, "This payment link has expired.");
    }

    // Validate one-time usage
    if (link.isOneTime && link.isUsed) {
      return renderStaticErrorPage(
        res,
        "This one-time payment link has already been used.",
      );
    }

    // Render beautiful landing page
    res.setHeader("Content-Type", "text/html");
    res.status(200).send(
      getLandingPageTemplate({
        amount: link.amount,
        currency: link.currency,
        description: link.description || "",
        token: link.token,
      }),
    );
  } catch (error) {
    console.error("Failed to render payment link landing:", error);
    res.status(500).send("Internal server error");
  }
}

/**
 * Public API to process the payment form submission.
 * POST /pay/:token/process
 */
export async function processPaymentHandler(
  req: Request,
  res: Response,
): Promise<Response> {
  try {
    const { token } = req.params;
    const { phoneNumber, provider } = req.body;

    if (!phoneNumber || !provider) {
      return res
        .status(400)
        .json({ error: "Phone number and provider are required" });
    }

    const link = await paymentLinkModel.findByToken(token);
    if (!link) {
      return res.status(404).json({ error: "Payment link not found" });
    }

    // Validate expiration
    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      return res.status(400).json({ error: "This payment link has expired" });
    }

    // Validate one-time usage
    if (link.isOneTime && link.isUsed) {
      return res
        .status(400)
        .json({ error: "This one-time payment link has already been used" });
    }

    // Create deposit transaction in the database
    const transaction = await transactionModel.create({
      type: "deposit",
      amount: link.amount,
      phoneNumber,
      provider,
      stellarAddress: link.stellarAddress,
      status: TransactionStatus.Pending,
      tags: ["payment-link"],
      notes: link.description || `Payment via link token ${token}`,
      userId: link.merchantId,
      idempotencyKey: null,
      idempotencyExpiresAt: null,
      locationMetadata: null,
    });

    // Mark payment link as used if one-time
    if (link.isOneTime) {
      await paymentLinkModel.markAsUsed(link.id);
    }

    // Submit job to queue worker for processing the deposit transaction
    await addTransactionJob(
      {
        transactionId: transaction.id,
        type: "deposit",
        amount: link.amount,
        phoneNumber,
        provider,
        stellarAddress: link.stellarAddress,
        requestId: (req as any).id,
      },
      {
        jobId: transaction.id,
      },
    );

    // Determine redirection success page URL
    const protocol = req.protocol;
    const host = req.get("host") || "";
    let redirectUrl = `${protocol}://${host}/pay/result/success?transactionId=${transaction.id}&reference=${transaction.referenceNumber}&amount=${link.amount}&currency=${link.currency}`;

    if (link.redirectSuccessUrl) {
      redirectUrl = link.redirectSuccessUrl;
    }

    return res.status(200).json({
      message: "Payment initiated successfully",
      redirectUrl,
    });
  } catch (error: any) {
    console.error("Failed to process payment link transaction:", error);
    return res
      .status(500)
      .json({
        error: error.message || "Failed to process payment link transaction",
      });
  }
}

/**
 * Public success view page.
 * GET /pay/result/success
 */
export function renderSuccessHandler(req: Request, res: Response): void {
  const {
    transactionId = "",
    reference = "",
    amount = "",
    currency = "",
  } = req.query;
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(
    getSuccessPageTemplate({
      transactionId: String(transactionId),
      reference: String(reference),
      amount: String(amount),
      currency: String(currency),
    }),
  );
}

/**
 * Public failure view page.
 * GET /pay/result/fail
 */
export function renderFailHandler(req: Request, res: Response): void {
  const { reason = "Payment transaction failed or timed out." } = req.query;
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(
    getFailPageTemplate({
      reason: String(reason),
    }),
  );
}

// Helpers for static pages
function renderStaticErrorPage(res: Response, message: string): void {
  res.setHeader("Content-Type", "text/html");
  res.status(400).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Link Issue | Secure Payment Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%);
      --card-bg: rgba(30, 41, 59, 0.45);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --error-color: #ef4444;
      --error-glow: rgba(239, 68, 68, 0.25);
    }
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg-gradient);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 48px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      text-align: center;
      width: 100%;
      max-width: 440px;
    }
    .icon-container {
      width: 72px;
      height: 72px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 8px 16px var(--error-glow);
    }
    .icon-svg {
      width: 36px;
      height: 36px;
      fill: var(--error-color);
    }
    .title {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .description {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-container">
      <svg class="icon-svg" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
      </svg>
    </div>
    <h1 class="title">Payment Link Expired or Invalid</h1>
    <p class="description">${message}</p>
  </div>
</body>
</html>
  `);
}

function getLandingPageTemplate(data: {
  amount: string;
  currency: string;
  description: string;
  token: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete Your Payment | Secure Payment Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%);
      --card-bg: rgba(30, 41, 59, 0.45);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary-color: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.35);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-color: #10b981;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg-gradient);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      overflow-x: hidden;
    }
    
    .container {
      width: 100%;
      max-width: 480px;
      perspective: 1000px;
    }
    
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      position: relative;
      overflow: hidden;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    
    .card::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, transparent 60%);
      pointer-events: none;
      z-index: 0;
    }
    
    .header {
      text-align: center;
      margin-bottom: 32px;
      position: relative;
      z-index: 1;
    }
    
    .logo-container {
      width: 64px;
      height: 64px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
    }
    
    .logo-svg {
      width: 32px;
      height: 32px;
      fill: var(--primary-color);
    }
    
    .title {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
    }
    
    .description {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    
    .details-box {
      background: rgba(15, 23, 42, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 28px;
      text-align: center;
      position: relative;
      z-index: 1;
    }
    
    .amount-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 4px;
      font-weight: 500;
    }
    
    .amount-value {
      font-size: 36px;
      font-weight: 700;
      color: var(--text-main);
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 6px;
    }
    
    .amount-currency {
      font-size: 18px;
      font-weight: 500;
      color: var(--primary-color);
    }
    
    .payment-for {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 8px;
    }
    
    .form-group {
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }
    
    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 8px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .input-wrapper {
      position: relative;
    }
    
    .input-field {
      width: 100%;
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 14px 16px;
      font-family: inherit;
      font-size: 15px;
      color: var(--text-main);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    
    .input-field:focus {
      border-color: var(--primary-color);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }
    
    .provider-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    
    .provider-option {
      position: relative;
    }
    
    .provider-option input {
      position: absolute;
      opacity: 0;
      cursor: pointer;
      height: 0;
      width: 0;
    }
    
    .provider-card {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .provider-option input:checked + .provider-card {
      background: rgba(99, 102, 241, 0.15);
      border-color: var(--primary-color);
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.2);
    }
    
    .provider-logo {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
    }
    
    .mtn-logo { background: #ffcc00; color: #000; }
    .airtel-logo { background: #e30613; color: #fff; }
    .orange-logo { background: #ff6600; color: #fff; }
    
    .provider-name {
      font-size: 12px;
      font-weight: 500;
    }
    
    .submit-btn {
      width: 100%;
      background: var(--primary-color);
      border: none;
      border-radius: 12px;
      padding: 16px;
      font-family: inherit;
      font-size: 16px;
      font-weight: 600;
      color: #ffffff;
      cursor: pointer;
      box-shadow: 0 4px 12px var(--primary-glow);
      transition: all 0.2s ease;
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    
    .submit-btn:hover {
      background: var(--primary-hover);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.45);
      transform: translateY(-1px);
    }
    
    .submit-btn:active {
      transform: translateY(1px);
    }
    
    .error-msg {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #f87171;
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 14px;
      margin-bottom: 24px;
      display: none;
      align-items: center;
      gap: 8px;
    }
    
    .footer-text {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 24px;
      position: relative;
      z-index: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="logo-container">
          <svg class="logo-svg" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/>
          </svg>
        </div>
        <h1 class="title">Secure Payment Link</h1>
        <p class="description">Complete your transaction using mobile money</p>
      </div>
      
      <div class="details-box">
        <div class="amount-label">Amount Due</div>
        <div class="amount-value">
          ${parseFloat(data.amount).toLocaleString()} <span class="amount-currency">${data.currency}</span>
        </div>
        ${data.description ? `<div class="payment-for">${data.description}</div>` : ""}
      </div>
      
      <div id="error-box" class="error-msg"></div>
      
      <form id="payment-form" action="/pay/${data.token}/process" method="POST">
        <div class="form-group">
          <label class="form-label" for="phone">Phone Number</label>
          <div class="input-wrapper">
            <input class="input-field" type="tel" id="phone" name="phoneNumber" placeholder="e.g. +237677777777" required>
          </div>
        </div>
        
        <div class="form-group">
          <label class="form-label">Select Mobile Provider</label>
          <div class="provider-grid">
            <label class="provider-option">
              <input type="radio" name="provider" value="mtn" checked required>
              <div class="provider-card">
                <div class="provider-logo mtn-logo">MTN</div>
                <div class="provider-name">MTN</div>
              </div>
            </label>
            <label class="provider-option">
              <input type="radio" name="provider" value="airtel" required>
              <div class="provider-card">
                <div class="provider-logo airtel-logo">AR</div>
                <div class="provider-name">Airtel</div>
              </div>
            </label>
            <label class="provider-option">
              <input type="radio" name="provider" value="orange" required>
              <div class="provider-card">
                <div class="provider-logo orange-logo">OR</div>
                <div class="provider-name">Orange</div>
              </div>
            </label>
          </div>
        </div>
        
        <button class="submit-btn" type="submit" id="pay-btn">
          Pay ${parseFloat(data.amount).toLocaleString()} ${data.currency}
        </button>
      </form>
      
      <div class="footer-text">
        Secured by Mobile Money & Stellar network
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById("payment-form");
    const errorBox = document.getElementById("error-box");
    const payBtn = document.getElementById("pay-btn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      
      payBtn.disabled = true;
      payBtn.innerText = "Processing Transaction...";
      errorBox.style.display = "none";
      
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());
      
      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (response.ok && result.redirectUrl) {
          window.location.href = result.redirectUrl;
        } else {
          throw new Error(result.error || "Payment failed");
        }
      } catch (err) {
        errorBox.innerText = err.message;
        errorBox.style.display = "flex";
        payBtn.disabled = false;
        payBtn.innerText = "Pay " + ${parseFloat(data.amount)} + " " + "${data.currency}";
      }
    });
  </script>
</body>
</html>
  `;
}

function getSuccessPageTemplate(data: {
  transactionId: string;
  reference: string;
  amount: string;
  currency: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful | Secure Payment Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%);
      --card-bg: rgba(30, 41, 59, 0.45);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-color: #10b981;
      --accent-glow: rgba(16, 185, 129, 0.25);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg-gradient);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      width: 100%;
      max-width: 440px;
    }
    
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 48px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    
    .icon-container {
      width: 72px;
      height: 72px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.25);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 8px 16px var(--accent-glow);
    }
    
    .icon-svg {
      width: 36px;
      height: 36px;
      fill: var(--accent-color);
    }
    
    .title {
      font-size: 26px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    
    .description {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 32px;
    }
    
    .receipt-box {
      background: rgba(15, 23, 42, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 32px;
      text-align: left;
    }
    
    .receipt-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 14px;
    }
    
    .receipt-row:last-child {
      margin-bottom: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 12px;
      font-weight: 600;
    }
    
    .row-label {
      color: var(--text-muted);
    }
    
    .row-value {
      color: var(--text-main);
    }
    
    .footer-text {
      font-size: 13px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon-container">
        <svg class="icon-svg" viewBox="0 0 24 24">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
      </div>
      <h1 class="title">Payment Successful</h1>
      <p class="description">Thank you! Your payment has been successfully initiated and is being processed by the network.</p>
      
      <div class="receipt-box">
        <div class="receipt-row">
          <span class="row-label">Transaction ID</span>
          <span class="row-value" style="font-family: monospace;">${data.transactionId}</span>
        </div>
        <div class="receipt-row">
          <span class="row-label">Reference</span>
          <span class="row-value" style="font-family: monospace;">${data.reference}</span>
        </div>
        <div class="receipt-row">
          <span class="row-label">Amount Paid</span>
          <span class="row-value" style="color: var(--accent-color)">${parseFloat(data.amount).toLocaleString()} ${data.currency}</span>
        </div>
      </div>
      
      <div class="footer-text">
        You may close this window.
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

function getFailPageTemplate(data: { reason: string }): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Failed | Secure Payment Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%);
      --card-bg: rgba(30, 41, 59, 0.45);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --error-color: #ef4444;
      --error-glow: rgba(239, 68, 68, 0.25);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg-gradient);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      width: 100%;
      max-width: 440px;
    }
    
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 48px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    
    .icon-container {
      width: 72px;
      height: 72px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 8px 16px var(--error-glow);
    }
    
    .icon-svg {
      width: 36px;
      height: 36px;
      fill: var(--error-color);
    }
    
    .title {
      font-size: 26px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    
    .description {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 32px;
    }
    
    .reason-box {
      background: rgba(239, 68, 68, 0.05);
      border: 1px solid rgba(239, 68, 68, 0.1);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 32px;
      color: #f87171;
      font-size: 14px;
      line-height: 1.5;
    }
    
    .retry-btn {
      display: inline-block;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 14px 28px;
      color: var(--text-main);
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      transition: all 0.2s ease;
      cursor: pointer;
    }
    
    .retry-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.2);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon-container">
        <svg class="icon-svg" viewBox="0 0 24 24">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </div>
      <h1 class="title">Payment Failed</h1>
      <p class="description">We were unable to complete your payment transaction. Please verify your details and try again.</p>
      
      <div class="reason-box">
        <strong>Error:</strong> ${data.reason}
      </div>
      
      <button class="retry-btn" onclick="window.history.back()">
        Try Again
      </button>
    </div>
  </div>
</body>
</html>
  `;
}
