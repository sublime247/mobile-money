import assert from "node:assert/strict";
import test from "node:test";
import { buildMomorcContent } from "./setupWizard";

test("buildMomorcContent serializes CLI config in .momorc format", () => {
  const content = buildMomorcContent({
    apiUrl: "https://api.example.com",
    apiKey: "secret-key",
    telemetry: true,
  });

  assert.equal(
    content,
    [
      "MOMO_API_URL=https://api.example.com",
      "MOMO_API_KEY=secret-key",
      "MOMO_TELEMETRY=true",
      "",
    ].join("\n"),
  );
});
