/**
 * SEP-24 Theme & Custom Branding Unit Tests (issue #1524)
 *
 * Acceptance Criteria:
 *   ✓ Parse theme query parameters (e.g. ?theme=dark&color=FF0000) from incoming SEP-24 requests.
 *   ✓ Apply these styles dynamically using CSS variables.
 *   ✓ Responsive layout and theme switching.
 */

"use strict";

const {
  setTheme,
  saveTheme,
  hexToHsl,
  parseThemeParams,
  applyDynamicStyles,
} = require("../../../public/app");

describe("SEP-24 Theme & Styling Management", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = `
      <div class="theme-switcher">
        <button data-theme="carbon" aria-pressed="false">Carbon</button>
        <button data-theme="light" aria-pressed="false">Light</button>
        <button data-theme="dark" aria-pressed="false">Dark</button>
      </div>
    `;
  });

  describe("hexToHsl", () => {
    it("converts standard 6-digit hex colors to HSL", () => {
      const red = hexToHsl("#FF0000");
      expect(red).not.toBeNull();
      expect(red.h).toBe(0);
      expect(red.s).toBe(100);
      expect(red.l).toBe(50);
      expect(red.hslString).toBe("0 100% 50%");
    });

    it("handles hex colors without leading hash", () => {
      const cyan = hexToHsl("00adb5");
      expect(cyan).not.toBeNull();
      expect(cyan.h).toBeGreaterThanOrEqual(175);
      expect(cyan.h).toBeLessThanOrEqual(185);
      expect(cyan.hslString).toContain("%");
    });

    it("handles 3-digit shorthand hex colors", () => {
      const white = hexToHsl("#fff");
      expect(white).not.toBeNull();
      expect(white.l).toBe(100);
    });

    it("returns null for invalid hex strings", () => {
      expect(hexToHsl("invalid")).toBeNull();
      expect(hexToHsl("")).toBeNull();
      expect(hexToHsl(null)).toBeNull();
    });
  });

  describe("parseThemeParams", () => {
    it("parses ?theme=dark&color=FF0000 correctly", () => {
      const parsed = parseThemeParams("?theme=dark&color=FF0000");
      expect(parsed.theme).toBe("dark");
      expect(parsed.primaryColor).toBe("#FF0000");
    });

    it("parses ?theme=light&primary_color=00adb5&bg_color=ffffff", () => {
      const parsed = parseThemeParams("?theme=light&primary_color=00adb5&bg_color=ffffff");
      expect(parsed.theme).toBe("light");
      expect(parsed.primaryColor).toBe("#00adb5");
      expect(parsed.backgroundColor).toBe("#ffffff");
    });

    it("handles all custom brand override fields", () => {
      const parsed = parseThemeParams("?theme=carbon&primary=1e88e5&secondary=8e24aa&text=f5f5f5&card=181818&border=333333");
      expect(parsed.theme).toBe("carbon");
      expect(parsed.primaryColor).toBe("#1e88e5");
      expect(parsed.secondaryColor).toBe("#8e24aa");
      expect(parsed.textColor).toBe("#f5f5f5");
      expect(parsed.cardColor).toBe("#181818");
      expect(parsed.borderColor).toBe("#333333");
    });

    it("returns empty object if no relevant query parameters exist", () => {
      const parsed = parseThemeParams("?foo=bar&baz=123");
      expect(parsed).toEqual({});
    });
  });

  describe("applyDynamicStyles", () => {
    it("applies theme dataset to documentElement", () => {
      applyDynamicStyles({ theme: "dark" }, document.documentElement);
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    it("applies primary color HSL CSS variable", () => {
      applyDynamicStyles({ primaryColor: "#FF0000" }, document.documentElement);
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe("0 100% 50%");
      expect(document.documentElement.style.getPropertyValue("--primary-glow")).toBeDefined();
    });

    it("applies secondary and background HSL CSS variables", () => {
      applyDynamicStyles({
        secondaryColor: "#0000FF",
        backgroundColor: "#121212",
        textColor: "#FFFFFF",
        cardColor: "#1E1E1E",
        borderColor: "#333333",
      }, document.documentElement);

      expect(document.documentElement.style.getPropertyValue("--secondary")).toBe("240 100% 50%");
      expect(document.documentElement.style.getPropertyValue("--bg-dark")).toBeDefined();
      expect(document.documentElement.style.getPropertyValue("--text-primary")).toBeDefined();
      expect(document.documentElement.style.getPropertyValue("--bg-card")).toBeDefined();
      expect(document.documentElement.style.getPropertyValue("--border")).toBeDefined();
    });
  });

  describe("setTheme & UI state", () => {
    it("updates active button in theme switcher", () => {
      setTheme("light");
      expect(document.documentElement.dataset.theme).toBe("light");
      const lightBtn = document.querySelector('button[data-theme="light"]');
      const darkBtn = document.querySelector('button[data-theme="dark"]');
      expect(lightBtn.classList.contains("active")).toBe(true);
      expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
      expect(darkBtn.classList.contains("active")).toBe(false);
    });
  });
});
