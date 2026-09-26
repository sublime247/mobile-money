import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("DepositModal component file exists and exports proper signatures", () => {
  const componentPath = path.resolve(__dirname, "../components/DepositModal.tsx");
  assert.ok(fs.existsSync(componentPath), "DepositModal.tsx must exist");

  const content = fs.readFileSync(componentPath, "utf-8");
  assert.ok(content.includes("export const DepositModal"), "Must export DepositModal");
  assert.ok(content.includes("export interface DepositModalProps"), "Must export DepositModalProps");
  assert.ok(content.includes("export interface Sep24CompletionEvent"), "Must export Sep24CompletionEvent");
  assert.ok(content.includes("export type ModalTheme"), "Must export ModalTheme");
});

test("DepositModal implements secure iframe embedding with sandbox", () => {
  const componentPath = path.resolve(__dirname, "../components/DepositModal.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(
    content.includes('sandbox="allow-scripts allow-forms allow-same-origin allow-popups"'),
    "Iframe must have secure sandbox restrictions"
  );
  assert.ok(
    content.includes('allow="camera; microphone; payment; clipboard-write"'),
    "Iframe must declare required permissions"
  );
  assert.ok(content.includes("sep24-deposit-iframe"), "Iframe must have identifier");
});

test("DepositModal implements popup fallback mode", () => {
  const componentPath = path.resolve(__dirname, "../components/DepositModal.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes("openPopupWindow"), "Must implement popup window opener");
  assert.ok(content.includes("window.open"), "Must call window.open for popup mode");
  assert.ok(content.includes("sep24-popup-toggle"), "Must provide mode switcher");
});

test("DepositModal implements postMessage event listening with origin validation", () => {
  const componentPath = path.resolve(__dirname, "../components/DepositModal.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes('window.addEventListener("message"'), "Must listen for message events");
  assert.ok(content.includes("trustedOrigins"), "Must support trustedOrigins validation");
  assert.ok(content.includes("onSuccess?.(typedPayload)"), "Must trigger onSuccess on completion");
  assert.ok(content.includes("onError?.(typedPayload)"), "Must trigger onError on failure");
});

test("DepositModal implements mobile-responsive dark/light theme toggle", () => {
  const componentPath = path.resolve(__dirname, "../components/DepositModal.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes("handleToggleTheme"), "Must implement theme toggle handler");
  assert.ok(content.includes("sep24-theme-toggle"), "Must include theme toggle button");
  assert.ok(content.includes("dark:bg-gray-900"), "Must have Tailwind dark mode classes");
  assert.ok(content.includes("sm:max-w-lg"), "Must have mobile-responsive classes");
});

test("DepositModal Storybook stories exist and cover required variants", () => {
  const storiesPath = path.resolve(__dirname, "../components/DepositModal.stories.tsx");
  assert.ok(fs.existsSync(storiesPath), "DepositModal.stories.tsx must exist");

  const content = fs.readFileSync(storiesPath, "utf-8");
  assert.ok(content.includes("Default: Story"), "Must have Default story");
  assert.ok(content.includes("DarkTheme: Story"), "Must have DarkTheme story");
  assert.ok(content.includes("PopupMode: Story"), "Must have PopupMode story");
  assert.ok(content.includes("MobileResponsiveView: Story"), "Must have MobileResponsiveView story");
});
