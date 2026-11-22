import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Postman collection file exists and is valid JSON", () => {
  const collectionPath = path.resolve(__dirname, "../mobile-money-bridge.json");
  assert.ok(fs.existsSync(collectionPath), "mobile-money-bridge.json must exist");

  const raw = fs.readFileSync(collectionPath, "utf-8");
  const data = JSON.parse(raw);

  assert.ok(data.info, "Must have info block");
  assert.strictEqual(data.info.name, "Mobile Money Bridge API");
  assert.ok(data.info.schema.includes("v2.1.0"), "Must follow Postman v2.1.0 schema");
});

test("Postman collection defines automated environment variables", () => {
  const collectionPath = path.resolve(__dirname, "../mobile-money-bridge.json");
  const data = JSON.parse(fs.readFileSync(collectionPath, "utf-8"));

  const variableKeys = data.variable.map((v) => v.key);
  assert.ok(variableKeys.includes("base_url"), "Must define base_url");
  assert.ok(variableKeys.includes("stellar_public_key"), "Must define stellar_public_key");
  assert.ok(variableKeys.includes("stellar_secret_key"), "Must define stellar_secret_key");
  assert.ok(variableKeys.includes("jwt_token"), "Must define jwt_token");
  assert.ok(variableKeys.includes("quote_id"), "Must define quote_id");
  assert.ok(variableKeys.includes("transaction_id"), "Must define transaction_id");
});

test("Postman collection contains all 5 required request categories", () => {
  const collectionPath = path.resolve(__dirname, "../mobile-money-bridge.json");
  const data = JSON.parse(fs.readFileSync(collectionPath, "utf-8"));

  const folderNames = data.item.map((item) => item.name);
  assert.ok(folderNames.some((f) => f.includes("Auth")), "Must have Auth folder");
  assert.ok(folderNames.some((f) => f.includes("KYC")), "Must have KYC folder");
  assert.ok(folderNames.some((f) => f.includes("Quotes")), "Must have Quotes folder");
  assert.ok(folderNames.some((f) => f.includes("Deposits")), "Must have Deposits folder");
  assert.ok(folderNames.some((f) => f.includes("Withdrawals")), "Must have Withdrawals folder");
});

test("Postman collection contains pre-request script auto-signing SEP-10 challenge", () => {
  const collectionPath = path.resolve(__dirname, "../mobile-money-bridge.json");
  const data = JSON.parse(fs.readFileSync(collectionPath, "utf-8"));

  const authFolder = data.item.find((f) => f.name.includes("Auth"));
  assert.ok(authFolder, "Auth folder must exist");

  const sep10SignReq = authFolder.item.find((r) => r.name.includes("Auto-Sign"));
  assert.ok(sep10SignReq, "SEP-10 Auto-Sign request must exist");

  const prerequestEvent = sep10SignReq.event.find((e) => e.listen === "prerequest");
  assert.ok(prerequestEvent, "Must have prerequest script");

  const scriptContent = prerequestEvent.script.exec.join("\n");
  assert.ok(scriptContent.includes("sep10/auth"), "Must reference SEP-10 auth endpoint");
  assert.ok(scriptContent.includes("challenge_xdr"), "Must manage challenge_xdr");
});

test("Postman requests include test assertions", () => {
  const collectionPath = path.resolve(__dirname, "../mobile-money-bridge.json");
  const data = JSON.parse(fs.readFileSync(collectionPath, "utf-8"));

  let totalRequests = 0;
  let requestsWithTests = 0;

  for (const folder of data.item) {
    for (const req of folder.item) {
      totalRequests++;
      const hasTest = req.event?.some((e) => e.listen === "test" && e.script?.exec?.length > 0);
      if (hasTest) requestsWithTests++;
    }
  }

  assert.ok(totalRequests >= 15, `Must have comprehensive requests (found ${totalRequests})`);
  assert.strictEqual(
    requestsWithTests,
    totalRequests,
    "All requests must include test assertions"
  );
});
