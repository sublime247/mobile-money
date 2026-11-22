import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/setup-pagerduty.sh");

it("requires running the PagerDuty setup from the project root", () => {
  const result = spawnSync("bash", [script], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Please run from project root");
});

it("checks the backlog implementation and runs the PagerDuty test suites", () => {
  const bin = mkdtempSync(path.join(tmpdir(), "pagerduty-test-"));
  try {
    const npm = path.join(bin, "npm");
    writeFileSync(npm, '#!/bin/bash\necho "npm $*"\n');
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("src/queue/webhookRetryQueue.ts");
    expect(result.stdout).toContain(
      "alertService.test.ts setupPagerduty.test.ts",
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
