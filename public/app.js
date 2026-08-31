// Theme Management & Custom Brand Dynamic Styling (SEP-24)
function setTheme(theme) {
  if (!document.documentElement) return;
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll(".theme-switcher button").forEach(btn => {
    const active = btn.dataset.theme === theme;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function saveTheme(theme) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("theme", theme);
  }
  setTheme(theme);
}

function hexToHsl(hex) {
  if (!hex || typeof hex !== "string") return null;
  let c = hex.replace("#", "").trim();
  if (c.length === 3) {
    c = c.split("").map(ch => ch + ch).join("");
  }
  if (c.length !== 6) return null;
  const num = parseInt(c, 16);
  if (isNaN(num)) return null;

  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  const hDeg = Math.round(h * 360);
  const sPct = Math.round(s * 100);
  const lPct = Math.round(l * 100);

  return {
    h: hDeg,
    s: sPct,
    l: lPct,
    hslString: `${hDeg} ${sPct}% ${lPct}%`
  };
}

function parseThemeParams(queryString) {
  const search = queryString !== undefined ? queryString : (typeof window !== "undefined" && window.location ? window.location.search : "");
  const params = new URLSearchParams(search);
  const result = {};

  const theme = params.get("theme");
  if (theme) result.theme = theme.toLowerCase();

  const color = params.get("color") || params.get("primary_color") || params.get("primary");
  if (color) result.primaryColor = color.startsWith("#") ? color : `#${color}`;

  const secondary = params.get("secondary_color") || params.get("secondary");
  if (secondary) result.secondaryColor = secondary.startsWith("#") ? secondary : `#${secondary}`;

  const bg = params.get("bg_color") || params.get("background") || params.get("bg");
  if (bg) result.backgroundColor = bg.startsWith("#") ? bg : `#${bg}`;

  const text = params.get("text_color") || params.get("text");
  if (text) result.textColor = text.startsWith("#") ? text : `#${text}`;

  const card = params.get("card_bg") || params.get("card");
  if (card) result.cardColor = card.startsWith("#") ? card : `#${card}`;

  const border = params.get("border_color") || params.get("border");
  if (border) result.borderColor = border.startsWith("#") ? border : `#${border}`;

  return result;
}

function applyDynamicStyles(overrides, targetElement) {
  const root = targetElement || (typeof document !== "undefined" ? document.documentElement : null);
  if (!overrides || !root || !root.style) return;

  if (overrides.theme) {
    setTheme(overrides.theme);
  }

  if (overrides.primaryColor) {
    const hsl = hexToHsl(overrides.primaryColor);
    if (hsl) {
      root.style.setProperty("--primary", hsl.hslString);
      root.style.setProperty("--primary-glow", `${hsl.h} ${hsl.s}% ${Math.min(100, hsl.l + 15)}%`);
    } else {
      root.style.setProperty("--primary-custom", overrides.primaryColor);
    }
  }

  if (overrides.secondaryColor) {
    const hsl = hexToHsl(overrides.secondaryColor);
    if (hsl) {
      root.style.setProperty("--secondary", hsl.hslString);
      root.style.setProperty("--secondary-glow", `${hsl.h} ${hsl.s}% ${Math.min(100, hsl.l + 15)}%`);
    }
  }

  if (overrides.backgroundColor) {
    const hsl = hexToHsl(overrides.backgroundColor);
    if (hsl) {
      root.style.setProperty("--bg-dark", hsl.hslString);
    }
  }

  if (overrides.cardColor) {
    const hsl = hexToHsl(overrides.cardColor);
    if (hsl) {
      root.style.setProperty("--bg-card", hsl.hslString);
      root.style.setProperty("--bg-card-hover", `${hsl.h} ${hsl.s}% ${Math.min(100, hsl.l + 4)}%`);
    }
  }

  if (overrides.textColor) {
    const hsl = hexToHsl(overrides.textColor);
    if (hsl) {
      root.style.setProperty("--text-primary", hsl.hslString);
    }
  }

  if (overrides.borderColor) {
    const hsl = hexToHsl(overrides.borderColor);
    if (hsl) {
      root.style.setProperty("--border", hsl.hslString);
    }
  }
}

function loadTheme() {
  const urlOverrides = parseThemeParams();
  if (urlOverrides.theme) {
    setTheme(urlOverrides.theme);
  } else {
    const saved = (typeof localStorage !== "undefined" && localStorage.getItem("theme")) || "carbon";
    setTheme(saved);
  }

  // Apply any custom color overrides passed in URL
  applyDynamicStyles(urlOverrides);
}

if (typeof document !== "undefined") {
  loadTheme();

  document.querySelectorAll(".theme-switcher button").forEach(btn => {
    btn.addEventListener("click", () => saveTheme(btn.dataset.theme));
  });
}

// Live API Status Polling
async function updateSystemStatus() {
  if (typeof document === "undefined") return;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (!dot || !text) return;

  try {
    const res = await fetch("/health");
    if (res.ok) {
      const data = await res.json();
      if (data.status === "ok") {
        dot.className = "status-dot online";
        text.className = "status-text online";
        text.textContent = "System: Operational";
        return;
      }
    }
    dot.className = "status-dot offline";
    text.className = "status-text";
    text.textContent = "System: Issues Detected";
  } catch (error) {
    dot.className = "status-dot offline";
    text.className = "status-text";
    text.textContent = "System: Offline";
  }
}

// Live Horizon Health Polling
async function updateHorizonHealth() {
  if (typeof document === "undefined") return;
  let horizonDot = document.getElementById("horizon-status-dot");
  let horizonText = document.getElementById("horizon-status-text");
  let horizonLatency = document.getElementById("horizon-latency");

  if (!horizonDot) {
    const statusContainer = document.querySelector(".status-container") || document.body;
    if (!statusContainer) return;
    const div = document.createElement("div");
    div.id = "horizon-health-widget";
    div.style.marginTop = "8px";
    div.innerHTML = `
      <span id="horizon-status-dot" class="status-dot offline"></span>
      <span id="horizon-status-text" class="status-text">Horizon: Checking...</span>
      <span id="horizon-latency" style="margin-left: 10px; font-size: 0.9em; opacity: 0.8;"></span>
    `;
    statusContainer.appendChild(div);
    horizonDot = document.getElementById("horizon-status-dot");
    horizonText = document.getElementById("horizon-status-text");
    horizonLatency = document.getElementById("horizon-latency");
  }

  try {
    const res = await fetch("/api/health/horizon");
    const data = await res.json();
    if (res.ok && data.status === "up") {
      horizonDot.className = "status-dot online";
      horizonText.className = "status-text online";
      horizonText.textContent = "Horizon: Connected";
      if (horizonLatency) {
        horizonLatency.textContent = `(${data.latencyMs}ms)`;
      }
    } else {
      horizonDot.className = "status-dot offline";
      horizonText.className = "status-text";
      horizonText.textContent = "Horizon: Degraded";
      if (horizonLatency && data.latencyMs) {
        horizonLatency.textContent = `(${data.latencyMs}ms)`;
      }
    }
  } catch (error) {
    if (horizonDot) horizonDot.className = "status-dot offline";
    if (horizonText) {
      horizonText.className = "status-text";
      horizonText.textContent = "Horizon: Offline";
    }
    if (horizonLatency) {
      horizonLatency.textContent = "";
    }
  }
}

// Initial status check and periodic updates
if (typeof window !== "undefined") {
  updateSystemStatus();
  updateHorizonHealth();
  setInterval(updateSystemStatus, 15000);
  setInterval(updateHorizonHealth, 15000);
}

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

const sendAmountInput = typeof document !== "undefined" ? document.getElementById("calc-send-amount") : null;
const sendCurrencySelect = typeof document !== "undefined" ? document.getElementById("calc-send-currency") : null;
const receiveAmountInput = typeof document !== "undefined" ? document.getElementById("calc-receive-amount") : null;
const receiveAssetSelect = typeof document !== "undefined" ? document.getElementById("calc-receive-asset") : null;

const rateDisplay = typeof document !== "undefined" ? document.getElementById("rate-display") : null;
const feeDisplay = typeof document !== "undefined" ? document.getElementById("fee-display") : null;
const finalDisplay = typeof document !== "undefined" ? document.getElementById("final-display") : null;

function calculateConversion() {
  if (!sendAmountInput || !sendCurrencySelect || !receiveAssetSelect) return;

  const sendAmt = parseFloat(sendAmountInput.value) || 0;
  const sendCurrency = sendCurrencySelect.value;
  const receiveAsset = receiveAssetSelect.value;

  const config = RATES[sendCurrency];
  if (!config) return;

  const rate = config[receiveAsset] || 0;
  const fee = sendAmt * 0.015;
  const netAmt = Math.max(0, sendAmt - fee);
  const receiveVal = netAmt * rate;

  const formattedFee = fee.toFixed(2);
  const formattedReceiveVal = receiveVal.toFixed(2);

  if (rateDisplay) {
    rateDisplay.textContent = config.rateStr.replace("USDC", receiveAsset);
  }
  if (feeDisplay) {
    feeDisplay.textContent = `${formattedFee} ${sendCurrency}`;
  }
  if (receiveAmountInput) {
    receiveAmountInput.value = formattedReceiveVal;
  }
  if (finalDisplay) {
    finalDisplay.textContent = `${formattedReceiveVal} ${receiveAsset}`;
  }
}

if (sendAmountInput) {
  sendAmountInput.addEventListener("input", calculateConversion);
  sendAmountInput.addEventListener("keypress", calculateConversion);
  sendAmountInput.addEventListener("keyup", calculateConversion);
  sendAmountInput.addEventListener("change", calculateConversion);
}
if (sendCurrencySelect) {
  sendCurrencySelect.addEventListener("change", calculateConversion);
}
if (receiveAssetSelect) {
  receiveAssetSelect.addEventListener("change", calculateConversion);
}

if (typeof document !== "undefined") {
  calculateConversion();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    setTheme,
    saveTheme,
    loadTheme,
    hexToHsl,
    parseThemeParams,
    applyDynamicStyles,
    calculateConversion,
    RATES,
  };
}
