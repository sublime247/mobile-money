import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("TransactionTracker component file exists and exports proper signatures", () => {
  const componentPath = path.resolve(__dirname, "../components/TransactionTracker.tsx");
  assert.ok(fs.existsSync(componentPath), "TransactionTracker.tsx must exist");

  const content = fs.readFileSync(componentPath, "utf-8");
  assert.ok(content.includes("export const TransactionTracker"), "Must export TransactionTracker");
  assert.ok(content.includes("export interface TransactionTrackerProps"), "Must export TransactionTrackerProps");
  assert.ok(content.includes("export const TRANSACTION_STEPS"), "Must export TRANSACTION_STEPS");
  assert.ok(content.includes("export type TrackerStep"), "Must export TrackerStep");
});

test("TransactionTracker implements the 4 required payment state transitions", () => {
  const componentPath = path.resolve(__dirname, "../components/TransactionTracker.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes('"initiated"'), "Must include initiated step");
  assert.ok(content.includes('"ussd_prompted"'), "Must include ussd_prompted step");
  assert.ok(content.includes('"confirmed"'), "Must include confirmed step");
  assert.ok(content.includes('"stellar_minted"'), "Must include stellar_minted step");
  assert.ok(content.includes("Stellar Minted"), "Must display Stellar Minted title");
  assert.ok(content.includes("USSD Prompted"), "Must display USSD Prompted title");
});

test("TransactionTracker connects to WebSocket and SSE feed with reconnection handling", () => {
  const componentPath = path.resolve(__dirname, "../components/TransactionTracker.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes("new WebSocket"), "Must instantiate WebSocket connection");
  assert.ok(content.includes("new EventSource"), "Must support SSE connection");
  assert.ok(content.includes("reconnectAttempts"), "Must track reconnection attempts");
  assert.ok(content.includes("Math.pow(2, prev)"), "Must implement exponential backoff reconnection");
  assert.ok(content.includes("connectWebSocket"), "Must have connectWebSocket method");
});

test("TransactionTracker implements elapsed time counter and timeout detection", () => {
  const componentPath = path.resolve(__dirname, "../components/TransactionTracker.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes("formatTime"), "Must format time counter (mm:ss)");
  assert.ok(content.includes("elapsedSeconds"), "Must track elapsed seconds");
  assert.ok(content.includes("timeoutSeconds"), "Must support timeout threshold");
  assert.ok(content.includes("timed_out"), "Must transition to timed_out state");
  assert.ok(content.includes("data-testid=\"elapsed-timer\""), "Must expose elapsed timer in DOM");
});

test("TransactionTracker shows clear failure resolution instructions if payment times out", () => {
  const componentPath = path.resolve(__dirname, "../components/TransactionTracker.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes("data-testid=\"failure-instructions\""), "Must render failure instructions card");
  assert.ok(content.includes("Recommended Resolution:"), "Must provide actionable resolution guidance");
  assert.ok(content.includes("USSD prompt was not dismissed"), "Must mention USSD verification");
  assert.ok(content.includes("balance covers the transaction"), "Must mention balance verification");
  assert.ok(content.includes("data-testid=\"retry-button\""), "Must provide retry button");
});

test("TransactionTracker Storybook stories cover all required variants", () => {
  const storiesPath = path.resolve(__dirname, "../components/TransactionTracker.stories.tsx");
  assert.ok(fs.existsSync(storiesPath), "TransactionTracker.stories.tsx must exist");

  const content = fs.readFileSync(storiesPath, "utf-8");
  assert.ok(content.includes("Initiated: Story"), "Must have Initiated story");
  assert.ok(content.includes("USSDPrompted: Story"), "Must have USSDPrompted story");
  assert.ok(content.includes("Confirmed: Story"), "Must have Confirmed story");
  assert.ok(content.includes("StellarMintedCompleted: Story"), "Must have StellarMintedCompleted story");
  assert.ok(content.includes("TimedOutWithInstructions: Story"), "Must have TimedOutWithInstructions story");
  assert.ok(content.includes("DarkTheme: Story"), "Must have DarkTheme story");
});
