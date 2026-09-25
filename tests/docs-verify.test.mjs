import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Provider integration guide exists at docs/provider_integration_guide.md", () => {
  const guidePath = path.resolve(__dirname, "../docs/provider_integration_guide.md");
  assert.ok(fs.existsSync(guidePath), "docs/provider_integration_guide.md must exist");

  const content = fs.readFileSync(guidePath, "utf-8");
  assert.ok(content.length > 1000, "Guide must be comprehensive");
});

test("Guide documents core interface requirements", () => {
  const guidePath = path.resolve(__dirname, "../docs/provider_integration_guide.md");
  const content = fs.readFileSync(guidePath, "utf-8");

  assert.ok(content.includes("initiateCollection"), "Must document initiateCollection()");
  assert.ok(content.includes("initiateDisbursement"), "Must document initiateDisbursement()");
  assert.ok(content.includes("verifyWebhook"), "Must document verifyWebhook()");
  assert.ok(content.includes("Status Normalization"), "Must document status normalization");
});

test("Guide contains sample provider code class", () => {
  const guidePath = path.resolve(__dirname, "../docs/provider_integration_guide.md");
  const content = fs.readFileSync(guidePath, "utf-8");

  assert.ok(content.includes("class WaveSenegalProvider"), "Must provide sample provider class");
  assert.ok(content.includes("extends BaseProvider"), "Sample class must extend BaseProvider");
  assert.ok(content.includes("implements MobileMoneyProvider"), "Sample class must implement MobileMoneyProvider");
  assert.ok(content.includes("timingSafeEqual"), "Must use timing safe equal for signatures");
});

test("Guide includes Mermaid sequence diagrams", () => {
  const guidePath = path.resolve(__dirname, "../docs/provider_integration_guide.md");
  const content = fs.readFileSync(guidePath, "utf-8");

  const mermaidOccurrences = (content.match(/```mermaid/g) || []).length;
  assert.ok(mermaidOccurrences >= 2, `Must include multiple Mermaid sequence diagrams (found ${mermaidOccurrences})`);
  assert.ok(content.includes("sequenceDiagram"), "Must declare sequenceDiagram");
});

test("Guide includes step-by-step developer runbook and checklist", () => {
  const guidePath = path.resolve(__dirname, "../docs/provider_integration_guide.md");
  const content = fs.readFileSync(guidePath, "utf-8");

  assert.ok(content.includes("Step-by-Step Integration Runbook"), "Must contain step-by-step runbook");
  assert.ok(content.includes("Operational Checklist"), "Must contain operational checklist");
  assert.ok(content.includes("Rollback Strategy"), "Must explain rollback strategy");
});
