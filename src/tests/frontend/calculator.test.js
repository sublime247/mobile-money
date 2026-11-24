/**
 * Frontend Calculator Unit Tests  (issue #1610)
 *
 * Acceptance criteria:
 *   ✓ Calculator updates its output value on input keypress events
 *   ✓ Fee values are calculated correctly (percentage, min clamp, max clamp)
 *   ✓ Test scripts execute cleanly
 *
 * All tests run in a JSDOM environment so no browser or backend is needed.
 * The calculator module under test is src/tests/frontend/calculator.js.
 */

"use strict";

const {
  DEFAULT_CONFIG,
  VIP_TIERS,
  calculateFee,
  mapVolumeToTier,
  calculateFeeWithDiscount,
  formatCurrency,
  bindCalculator,
} = require("./calculator");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal JSDOM-like document stub with the calculator HTML elements.
 * We use real JSDOM (provided by jest's testEnvironment) via document.
 */
function buildCalcDOM() {
  // Reset the body for each test that needs DOM
  document.body.innerHTML = `
    <input  id="calc-amount"   type="number" value="0" />
    <input  id="calc-volume"   type="number" value="0" />
    <output id="calc-fee"      value="0" />
    <output id="calc-total"    value="0" />
    <output id="calc-tier"     value="" />
    <output id="calc-discount" value="" />
  `;
}

function buildCalcDOMSimple() {
  document.body.innerHTML = `
    <input  id="calc-amount" type="number" value="0" />
    <output id="calc-fee"    value="0" />
    <output id="calc-total"  value="0" />
  `;
}

/** Fire a synthetic keyup event on an element */
function fireKeyup(el, key) {
  const event = new KeyboardEvent("keyup", { key: key || "0", bubbles: true });
  el.dispatchEvent(event);
}

/** Fire a synthetic input event on an element */
function fireInput(el) {
  const event = new Event("input", { bubbles: true });
  el.dispatchEvent(event);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. calculateFee — pure fee logic
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateFee", () => {
  describe("percentage calculation", () => {
    it("applies 1.5% fee to a normal amount", () => {
      const { fee, total } = calculateFee(10000);
      expect(fee).toBe(150);
      expect(total).toBe(10150);
    });

    it("returns fee and total as numbers with ≤2 decimal places", () => {
      const { fee, total } = calculateFee(7777);
      expect(Number.isFinite(fee)).toBe(true);
      expect(Number.isFinite(total)).toBe(true);
      expect(fee.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    });

    it("total always equals amount + fee", () => {
      [100, 1000, 5000, 25000, 100000].forEach((amount) => {
        const { fee, total } = calculateFee(amount);
        expect(total).toBeCloseTo(amount + fee, 5);
      });
    });
  });

  describe("minimum fee clamp", () => {
    it("enforces minimum fee of 50 for very small amounts", () => {
      const { fee } = calculateFee(100); // 1.5% = 1.5 → clamped to 50
      expect(fee).toBe(50);
    });

    it("enforces minimum fee for zero amount", () => {
      const { fee, total } = calculateFee(0);
      expect(fee).toBe(50);
      expect(total).toBe(50);
    });

    it("does not clamp when fee naturally exceeds minimum", () => {
      const { fee } = calculateFee(10000); // 150 > 50
      expect(fee).toBe(150);
    });

    it("clamp boundary: amount 3333 gives fee just below 50", () => {
      const { fee } = calculateFee(3333); // 1.5% = 49.995 → clamped to 50
      expect(fee).toBe(50);
    });

    it("clamp boundary: amount 3334 gives fee just above 50", () => {
      const { fee } = calculateFee(3334); // 1.5% = 50.01 → not clamped
      expect(fee).toBeGreaterThanOrEqual(50);
    });
  });

  describe("maximum fee clamp", () => {
    it("enforces maximum fee of 5000 for very large amounts", () => {
      const { fee } = calculateFee(1_000_000); // 1.5% = 15000 → clamped to 5000
      expect(fee).toBe(5000);
    });

    it("clamp boundary: amount 333333 gives fee just below 5000", () => {
      const { fee } = calculateFee(333_333); // ≈ 4999.995 → rounded to 4999.99 (< 5000 max clamp)
      expect(fee).toBeLessThanOrEqual(5000);
    });
  });

  describe("custom configuration", () => {
    it("uses provided feePercentage override", () => {
      const { fee } = calculateFee(10000, { feePercentage: 2.0 });
      expect(fee).toBe(200);
    });

    it("uses provided feeMinimum override", () => {
      const { fee } = calculateFee(10, { feeMinimum: 5 }); // 1.5% = 0.15 → clamped to 5
      expect(fee).toBe(5);
    });

    it("uses provided feeMaximum override", () => {
      const { fee } = calculateFee(1_000_000, { feeMaximum: 100 });
      expect(fee).toBe(100);
    });

    it("handles feePercentage = 0 (free transactions)", () => {
      const { fee } = calculateFee(50000, {
        feePercentage: 0,
        feeMinimum:    0,
        feeMaximum:    0,
      });
      expect(fee).toBe(0);
    });
  });

  describe("input validation", () => {
    it("throws TypeError for non-numeric amount", () => {
      expect(() => calculateFee("1000")).toThrow(TypeError);
    });

    it("throws TypeError for NaN", () => {
      expect(() => calculateFee(NaN)).toThrow(TypeError);
    });

    it("throws TypeError for negative amount", () => {
      expect(() => calculateFee(-100)).toThrow(TypeError);
    });

    it("accepts zero as valid amount", () => {
      expect(() => calculateFee(0)).not.toThrow();
    });
  });

  describe("configUsed field", () => {
    it("returns configUsed = 'calculator'", () => {
      const { configUsed } = calculateFee(10000);
      expect(configUsed).toBe("calculator");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. mapVolumeToTier
// ─────────────────────────────────────────────────────────────────────────────

describe("mapVolumeToTier", () => {
  it.each([
    [0,       "STANDARD",  0],
    [999,     "STANDARD",  0],
    [1000,    "SILVER",   20],
    [4999,    "SILVER",   20],
    [5000,    "GOLD",     35],
    [19999,   "GOLD",     35],
    [20000,   "PLATINUM", 50],
    [49999,   "PLATINUM", 50],
    [50000,   "DIAMOND",  65],
    [200000,  "DIAMOND",  65],
  ])("volume %d → tier %s (%d%% discount)", (volume, expectedTier, expectedDiscount) => {
    const result = mapVolumeToTier(volume);
    expect(result.tier).toBe(expectedTier);
    expect(result.discountPercent).toBe(expectedDiscount);
  });

  it("returns STANDARD for volume 0", () => {
    expect(mapVolumeToTier(0).tier).toBe("STANDARD");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. calculateFeeWithDiscount — VIP tier logic
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateFeeWithDiscount", () => {
  describe("tier assignment", () => {
    it("returns STANDARD tier for low-volume user", () => {
      const { tier, discountPercent } = calculateFeeWithDiscount(10000, 500);
      expect(tier).toBe("STANDARD");
      expect(discountPercent).toBe(0);
    });

    it("returns SILVER tier for 1000–4999 volume", () => {
      const { tier, discountPercent } = calculateFeeWithDiscount(10000, 2500);
      expect(tier).toBe("SILVER");
      expect(discountPercent).toBe(20);
    });

    it("returns GOLD tier for 5000–19999 volume", () => {
      const { tier } = calculateFeeWithDiscount(10000, 10000);
      expect(tier).toBe("GOLD");
    });

    it("returns PLATINUM tier for 20000–49999 volume", () => {
      const { tier } = calculateFeeWithDiscount(10000, 25000);
      expect(tier).toBe("PLATINUM");
    });

    it("returns DIAMOND tier for ≥50000 volume", () => {
      const { tier, discountPercent } = calculateFeeWithDiscount(10000, 60000);
      expect(tier).toBe("DIAMOND");
      expect(discountPercent).toBe(65);
    });
  });

  describe("discounted fee calculation", () => {
    // Base rate 1.5%, SILVER 20% off → effective 1.2%
    it("SILVER: applies 20% discount to base rate", () => {
      const { fee } = calculateFeeWithDiscount(10000, 2500);
      // 10000 × 1.2% = 120
      expect(fee).toBe(120);
    });

    // GOLD 35% off → effective 0.975%
    it("GOLD: applies 35% discount to base rate", () => {
      const { fee } = calculateFeeWithDiscount(10000, 10000);
      // 10000 × 0.975% = 97.5
      expect(fee).toBeCloseTo(97.5, 1);
    });

    // PLATINUM 50% off → effective 0.75%
    it("PLATINUM: applies 50% discount to base rate", () => {
      const { fee } = calculateFeeWithDiscount(10000, 25000);
      // 10000 × 0.75% = 75
      expect(fee).toBe(75);
    });

    // DIAMOND 65% off → effective 0.525%
    it("DIAMOND: applies 65% discount to base rate", () => {
      const { fee } = calculateFeeWithDiscount(50000, 60000);
      // 50000 × 0.525% = 262.5
      expect(fee).toBeCloseTo(262.5, 1);
    });

    it("discounted fee is strictly less than standard fee for same amount", () => {
      const standard  = calculateFeeWithDiscount(10000, 0).fee;
      const silver    = calculateFeeWithDiscount(10000, 2500).fee;
      const diamond   = calculateFeeWithDiscount(10000, 60000).fee;
      expect(silver).toBeLessThan(standard);
      expect(diamond).toBeLessThan(silver);
    });
  });

  describe("discounted min/max clamp", () => {
    // DIAMOND: min = 50 × 0.35 = 17.5
    it("clamps to discounted minimum for tiny amounts (DIAMOND)", () => {
      const { fee } = calculateFeeWithDiscount(100, 60000);
      // 100 × 0.525% = 0.525 → clamped to 17.5
      expect(fee).toBe(17.5);
    });

    // DIAMOND: max = 5000 × 0.35 = 1750
    it("clamps to discounted maximum for huge amounts (DIAMOND)", () => {
      const { fee } = calculateFeeWithDiscount(10_000_000, 60000);
      expect(fee).toBe(1750);
    });
  });

  describe("total = amount + fee", () => {
    it("total is always amount + fee", () => {
      [[10000, 0], [10000, 2500], [10000, 60000]].forEach(([amount, vol]) => {
        const { fee, total } = calculateFeeWithDiscount(amount, vol);
        expect(total).toBeCloseTo(amount + fee, 5);
      });
    });
  });

  describe("input validation", () => {
    it("throws TypeError for invalid amount", () => {
      expect(() => calculateFeeWithDiscount(-1, 1000)).toThrow(TypeError);
    });

    it("throws TypeError for invalid volume", () => {
      expect(() => calculateFeeWithDiscount(1000, -1)).toThrow(TypeError);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. formatCurrency
// ─────────────────────────────────────────────────────────────────────────────

describe("formatCurrency", () => {
  it("returns a non-empty string for a valid number", () => {
    const result = formatCurrency(10150);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns '—' for NaN", () => {
    expect(formatCurrency(NaN)).toBe("—");
  });

  it("returns '—' for non-numeric input", () => {
    expect(formatCurrency("abc")).toBe("—");
  });

  it("includes the amount value in the formatted string", () => {
    const result = formatCurrency(5000, "XAF");
    // The number 5000 should appear somewhere in the formatted output
    expect(result.replace(/[\s,\.]/g, "")).toMatch(/5000/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. bindCalculator — DOM + keypress event integration
//    These tests prove the acceptance criterion:
//    "Calculator updates value on input keypress events"
// ─────────────────────────────────────────────────────────────────────────────

describe("bindCalculator — DOM integration", () => {
  let calc;

  afterEach(() => {
    if (calc) {
      calc.destroy();
      calc = null;
    }
    document.body.innerHTML = "";
  });

  // ── 5a. Basic binding ──────────────────────────────────────────────────────

  it("binds without throwing when required elements are present", () => {
    buildCalcDOMSimple();
    expect(() => {
      calc = bindCalculator(document);
    }).not.toThrow();
  });

  it("throws when #calc-amount is missing", () => {
    document.body.innerHTML = `
      <output id="calc-fee"   />
      <output id="calc-total" />
    `;
    expect(() => bindCalculator(document)).toThrow(/calc-amount/);
  });

  it("throws when #calc-fee is missing", () => {
    document.body.innerHTML = `<input id="calc-amount" type="number" />`;
    expect(() => bindCalculator(document)).toThrow(/calc-fee/);
  });

  // ── 5b. keyup event → output updates ──────────────────────────────────────

  it("updates fee output on keyup event with a normal amount", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");
    const totalOutput = document.getElementById("calc-total");

    amountInput.value = "10000";
    fireKeyup(amountInput, "0");

    expect(parseFloat(feeOutput.value)).toBe(150);
    expect(parseFloat(totalOutput.value)).toBe(10150);
  });

  it("updates fee output on keyup to enforce minimum fee", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");

    amountInput.value = "100"; // 1.5% = 1.5 → clamped to 50
    fireKeyup(amountInput, "0");

    expect(parseFloat(feeOutput.value)).toBe(50);
  });

  it("updates fee output on keyup to enforce maximum fee", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");

    amountInput.value = "1000000"; // 1.5% = 15000 → clamped to 5000
    fireKeyup(amountInput, "0");

    expect(parseFloat(feeOutput.value)).toBe(5000);
  });

  it("resets to minimum fee when amount is cleared (empty → 0)", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");

    amountInput.value = "10000";
    fireKeyup(amountInput, "0");

    amountInput.value = "";
    fireKeyup(amountInput, "Backspace");

    // Empty string → parseFloat("") = NaN → treated as 0 → minimum fee
    expect(parseFloat(feeOutput.value)).toBe(50);
  });

  // ── 5c. input event also triggers update ──────────────────────────────────

  it("also updates on 'input' event (not just keyup)", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");

    amountInput.value = "5000";
    fireInput(amountInput);

    // 5000 × 1.5% = 75 → clamped to 50 (no, 75 > 50)
    expect(parseFloat(feeOutput.value)).toBe(75);
  });

  // ── 5d. Multiple keystrokes produce correct running output ─────────────────

  it("recalculates correctly across multiple sequential keystrokes", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");
    const totalOutput = document.getElementById("calc-total");

    const steps = [
      { amount: "1",     expectedFee: 50,    expectedTotal: 51      },
      { amount: "100",   expectedFee: 50,    expectedTotal: 150     },
      { amount: "1000",  expectedFee: 50,    expectedTotal: 1050    },
      { amount: "3334",  expectedFee: 50.01, expectedTotal: 3384.01 },
      { amount: "10000", expectedFee: 150,   expectedTotal: 10150   },
    ];

    steps.forEach(({ amount, expectedFee, expectedTotal }) => {
      amountInput.value = amount;
      fireKeyup(amountInput, amount.slice(-1));

      expect(parseFloat(feeOutput.value)).toBeCloseTo(expectedFee, 1);
      expect(parseFloat(totalOutput.value)).toBeCloseTo(expectedTotal, 1);
    });
  });

  // ── 5e. VIP volume input also triggers update ──────────────────────────────

  it("updates tier and fee when volume input fires keyup", () => {
    buildCalcDOM();
    calc = bindCalculator(document);

    const amountInput  = document.getElementById("calc-amount");
    const volumeInput  = document.getElementById("calc-volume");
    const feeOutput    = document.getElementById("calc-fee");
    const tierOutput   = document.getElementById("calc-tier");

    amountInput.value = "10000";
    fireKeyup(amountInput, "0");

    volumeInput.value = "2500"; // SILVER — 20% discount
    fireKeyup(volumeInput, "0");

    // 10000 × 1.2% = 120
    expect(parseFloat(feeOutput.value)).toBeCloseTo(120, 1);
    expect(tierOutput.value).toBe("SILVER");
  });

  it("upgrades tier to DIAMOND and reduces fee correctly on volume keyup", () => {
    buildCalcDOM();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const volumeInput = document.getElementById("calc-volume");
    const feeOutput   = document.getElementById("calc-fee");
    const tierOutput  = document.getElementById("calc-tier");

    amountInput.value = "50000";
    volumeInput.value = "60000"; // DIAMOND
    fireKeyup(volumeInput, "0");

    // 50000 × 0.525% = 262.5
    expect(parseFloat(feeOutput.value)).toBeCloseTo(262.5, 1);
    expect(tierOutput.value).toBe("DIAMOND");
  });

  // ── 5f. manual update() call ──────────────────────────────────────────────

  it("manual update() call produces correct output without a DOM event", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document);

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");

    amountInput.value = "20000";
    calc.update();

    // 20000 × 1.5% = 300
    expect(parseFloat(feeOutput.value)).toBe(300);
  });

  // ── 5g. custom config ─────────────────────────────────────────────────────

  it("respects custom fee config passed to bindCalculator", () => {
    buildCalcDOMSimple();
    calc = bindCalculator(document, { feePercentage: 2.0, feeMinimum: 0, feeMaximum: 99999 });

    const amountInput = document.getElementById("calc-amount");
    const feeOutput   = document.getElementById("calc-fee");

    amountInput.value = "5000";
    fireKeyup(amountInput, "0");

    // 5000 × 2.0% = 100
    expect(parseFloat(feeOutput.value)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DEFAULT_CONFIG and VIP_TIERS constants
// ─────────────────────────────────────────────────────────────────────────────

describe("module constants", () => {
  it("DEFAULT_CONFIG has expected shape", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      feePercentage: expect.any(Number),
      feeMinimum:    expect.any(Number),
      feeMaximum:    expect.any(Number),
    });
    expect(DEFAULT_CONFIG.feePercentage).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.feeMinimum).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.feeMaximum).toBeGreaterThan(DEFAULT_CONFIG.feeMinimum);
  });

  it("VIP_TIERS has five entries in descending volume order", () => {
    expect(VIP_TIERS).toHaveLength(5);
    for (let i = 1; i < VIP_TIERS.length; i++) {
      expect(VIP_TIERS[i].minVolume).toBeLessThan(VIP_TIERS[i - 1].minVolume);
    }
  });

  it("VIP_TIERS discount percentages are strictly decreasing", () => {
    for (let i = 1; i < VIP_TIERS.length; i++) {
      expect(VIP_TIERS[i].discountPercent).toBeLessThan(
        VIP_TIERS[i - 1].discountPercent,
      );
    }
  });

  it("last VIP_TIER entry has minVolume = 0 and discountPercent = 0 (STANDARD)", () => {
    const last = VIP_TIERS[VIP_TIERS.length - 1];
    expect(last.tier).toBe("STANDARD");
    expect(last.minVolume).toBe(0);
    expect(last.discountPercent).toBe(0);
  });
});
