// Live API Status Polling
async function updateSystemStatus() {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");

  try {
    const res = await fetch("/ready");
    if (res.ok) {
      const data = await res.json();
      if (data.status === "ready") {
        dot.className = "status-dot online";
        text.textContent = "System: Operational";
        return;
      }
    }
    dot.className = "status-dot offline";
    text.textContent = "System: Issues Detected";
  } catch (error) {
    dot.className = "status-dot offline";
    text.textContent = "System: Offline";
  }
}

// Initial status check and periodic updates
updateSystemStatus();
setInterval(updateSystemStatus, 15000);

// Interactive Exchange Rate Calculator
const RATES = {
  NGN: { USDC: 0.000645, XLM: 0.00645, label: "NGN", rateStr: "1 NGN = 0.00065 USDC" },
  XAF: { USDC: 0.001667, XLM: 0.01667, label: "XAF", rateStr: "1 XAF = 0.00167 USDC" },
  KES: { USDC: 0.007692, XLM: 0.07692, label: "KES", rateStr: "1 KES = 0.00769 USDC" },
  GHS: { USDC: 0.066667, XLM: 0.66667, label: "GHS", rateStr: "1 GHS = 0.0667 USDC" },
  TZS: { USDC: 0.000385, XLM: 0.003846, label: "TZS", rateStr: "1 TZS = 0.00038 USDC" },
  ZMW: { USDC: 0.037037, XLM: 0.37037, label: "ZMW", rateStr: "1 ZMW = 0.0370 USDC" },
  RWF: { USDC: 0.000758, XLM: 0.007576, label: "RWF", rateStr: "1 RWF = 0.00076 USDC" }
};

const sendAmountInput = document.getElementById("calc-send-amount");
const sendCurrencySelect = document.getElementById("calc-send-currency");
const receiveAmountInput = document.getElementById("calc-receive-amount");
const receiveAssetSelect = document.getElementById("calc-receive-asset");

const rateDisplay = document.getElementById("rate-display");
const feeDisplay = document.getElementById("fee-display");
const finalDisplay = document.getElementById("final-display");

function calculateConversion() {
  const sendAmt = parseFloat(sendAmountInput.value) || 0;
  const sendCurrency = sendCurrencySelect.value;
  const receiveAsset = receiveAssetSelect.value;

  const config = RATES[sendCurrency];
  const rate = config[receiveAsset];

  // Operator fee (1.5%)
  const fee = sendAmt * 0.015;
  const netAmt = Math.max(0, sendAmt - fee);
  const receiveVal = netAmt * rate;

  // Update DOM elements
  rateDisplay.textContent = config.rateStr.replace("USDC", receiveAsset);
  feeDisplay.textContent = `${fee.toFixed(0)} ${sendCurrency}`;
  receiveAmountInput.value = receiveVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  finalDisplay.textContent = `${receiveAmountInput.value} ${receiveAsset}`;
}

// Add event listeners for inputs
sendAmountInput.addEventListener("input", calculateConversion);
sendCurrencySelect.addEventListener("change", calculateConversion);
receiveAssetSelect.addEventListener("change", calculateConversion);

// Initial calculation
calculateConversion();

// Fetch live rates from our backend proxy
async function loadLiveRates() {
  try {
    const res = await fetch("/api/live-rates");
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.rates) {
        const rates = data.rates;
        for (const cur of Object.keys(RATES)) {
          if (rates[cur]) {
            const rawRate = rates[cur];
            RATES[cur].USDC = 1 / rawRate;
            RATES[cur].XLM = 10 / rawRate; // mock rate 1 USDC = 10 XLM
            RATES[cur].rateStr = `1 ${cur} = ${(1 / rawRate).toFixed(6)} USDC`;
          }
        }
        console.log("Live rates loaded successfully");
        calculateConversion();
      }
    }
  } catch (error) {
    console.warn("Failed to load live rates, using fallback:", error);
  }
}

loadLiveRates();

// API Explorer Tabs
const CODE_SNIPPETS = {
  deposit: `curl -X POST http://localhost:3000/api/transactions/deposit \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: dev-admin-key" \\
  -d '{
    "amount": 2500,
    "phoneNumber": "+237670000000",
    "provider": "mtn",
    "stellarAddress": "GBNGNTEDRBGZN2N7HQ3TUKA76U2YKRMTXPFPDPPJOSVDLQX5S4PXX7E3",
    "userId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "notes": "Savings Deposit"
  }'`,
  withdraw: `curl -X POST http://localhost:3000/api/transactions/withdraw \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: dev-admin-key" \\
  -d '{
    "amount": 1500,
    "phoneNumber": "+255700000000",
    "provider": "airtel",
    "stellarAddress": "GBNGNTEDRBGZN2N7HQ3TUKA76U2YKRMTXPFPDPPJOSVDLQX5S4PXX7E3",
    "userId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "notes": "Remittance Payout"
  }'`,
  paylink: `curl -X POST http://localhost:3000/api/payment-links \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: dev-admin-key" \\
  -d '{
    "amount": 5000,
    "currency": "XAF",
    "merchantId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "description": "Invoice #88493"
  }'`,
  toml: `curl -X GET http://localhost:3000/.well-known/stellar.toml`,
  kyc: `curl -X POST http://localhost:3000/api/kyc/upload \\
  -H "X-API-Key: dev-admin-key" \\
  -F "file=@/path/to/passport.jpg" \\
  -F "type=id_card" \\
  -F "userId=a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"`,
  stats: `curl -X GET http://localhost:3000/api/v1/stats \\
  -H "X-API-Key: dev-admin-key"`
};

function selectTab(tabName) {
  // Update active classes on buttons
  const tabs = ["deposit", "withdraw", "paylink", "toml", "kyc", "stats"];
  tabs.forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (t === tabName) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Update code content
  document.getElementById("code-snippet").textContent = CODE_SNIPPETS[tabName];
}

// Copy Code Helper
function copyCode() {
  const codeText = document.getElementById("code-snippet").textContent;
  navigator.clipboard.writeText(codeText).then(() => {
    const btn = document.getElementById("btn-copy-code");
    const originalText = btn.textContent;
    btn.textContent = "Copied! ✓";
    btn.style.backgroundColor = "rgba(16, 185, 129, 0.2)";
    btn.style.color = "#10b981";
    btn.style.borderColor = "#10b981";
    
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.backgroundColor = "";
      btn.style.color = "";
      btn.style.borderColor = "";
    }, 2000);
  });
}

// Bind Event Listeners for CSP Compliance
document.getElementById("tab-btn-deposit").addEventListener("click", () => selectTab("deposit"));
document.getElementById("tab-btn-withdraw").addEventListener("click", () => selectTab("withdraw"));
document.getElementById("tab-btn-paylink").addEventListener("click", () => selectTab("paylink"));
document.getElementById("tab-btn-toml").addEventListener("click", () => selectTab("toml"));
document.getElementById("tab-btn-kyc").addEventListener("click", () => selectTab("kyc"));
document.getElementById("tab-btn-stats").addEventListener("click", () => selectTab("stats"));
document.getElementById("btn-copy-code").addEventListener("click", copyCode);
