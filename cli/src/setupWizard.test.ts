import assert from "node:assert/strict";
import test from "node:test";
import { buildMomorcContent } from "./setupWizard";

test("buildMomorcContent serializes CLI config in .momorc format", () => {
  const content = buildMomorcContent({
    apiUrl: "https://api.example.com",
    apiKey: "secret-key",
  });

  assert.equal(
    content,
    [
      "MOMO_API_URL=https://api.example.com",
      "MOMO_API_KEY=secret-key",
      "",
    ].join("\n"),
  );
});
