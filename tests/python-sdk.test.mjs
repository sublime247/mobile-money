import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Python SDK package structure and pyproject.toml are valid", () => {
  const sdkDir = path.resolve(__dirname, "../sdk/python");
  const pyproject = path.join(sdkDir, "pyproject.toml");
  const readme = path.join(sdkDir, "README.md");
  const initPy = path.join(sdkDir, "mobile_money_stellar/__init__.py");
  const modelsPy = path.join(sdkDir, "mobile_money_stellar/models.py");
  const clientPy = path.join(sdkDir, "mobile_money_stellar/client.py");
  const asyncClientPy = path.join(sdkDir, "mobile_money_stellar/async_client.py");

  assert.ok(fs.existsSync(pyproject), "pyproject.toml must exist");
  assert.ok(fs.existsSync(readme), "README.md must exist");
  assert.ok(fs.existsSync(initPy), "__init__.py must exist");
  assert.ok(fs.existsSync(modelsPy), "models.py must exist");
  assert.ok(fs.existsSync(clientPy), "client.py must exist");
  assert.ok(fs.existsSync(asyncClientPy), "async_client.py must exist");

  const pyprojectContent = fs.readFileSync(pyproject, "utf-8");
  assert.ok(pyprojectContent.includes('name = "mobile-money-stellar"'), "Package name must match");
  assert.ok(pyprojectContent.includes("httpx"), "Must declare httpx dependency");
  assert.ok(pyprojectContent.includes("pydantic"), "Must declare pydantic dependency");
});

test("Python test suite executes successfully with mock execution framework", () => {
  const runnerPath = path.resolve(__dirname, "../sdk/python/tests/run_tests.py");
  const output = execSync(`python3 "${runnerPath}" 2>&1`, { encoding: "utf-8" });
  assert.ok(output.includes("OK"), "Python test suite must pass completely");
});
